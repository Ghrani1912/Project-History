import type { BrainConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { countChatTurns } from './chat.js';
import { countCommits } from './commits.js';
import { countDecisions } from './decisions.js';
import { countEvents } from './events.js';
import { listProjects } from './projects.js';
import { buildTimeline } from './timeline.js';
import type { OwnerType, ProjectRow, SearchHit, TimelineEntry } from './types.js';
import { hasOllamaModel, listOllamaModels, resolveOllamaModel } from '../embeddings/embedder.js';
import { createOllamaLlm } from '../llm/ollama.js';
import { buildProjectProfile, type ProjectProfile } from '../summarize/profile.js';
import { log } from '../util/logger.js';
import { plural, relativeTime, truncate } from '../util/format.js';

/**
 * Recall returns ranked passages; a person asked a question. This module writes
 * the answer: it explains the workspace from its stored overview and real
 * structure, says where things stand, and only then falls back to quoting the
 * closest evidence. Passages are kept as citations rather than being dumped as
 * the answer itself. When a local model is installed it writes the prose
 * instead, but the deterministic path is what runs offline and it is not a stub.
 */

export interface AnswerSource {
  kind: OwnerType;
  project: string | null;
  ts: number;
  snippet: string;
}

export interface GroundedAnswer {
  /** Prose the panel renders above the citations. */
  text: string;
  generator: 'stored-overview' | 'captured-history' | 'local-model' | 'insufficient-evidence';
  /** True when this is composed from records rather than written by a model. */
  partial: boolean;
  sources: AnswerSource[];
  llm: { used: boolean; model: string; reason?: string };
}

export interface AnswerInput {
  query: string;
  project: ProjectRow | null;
  hits: SearchHit[];
  /** Retrieval was a semantic near-miss, so the model must not riff on it. */
  weak?: boolean;
  /** Ask the local model to write the prose; silently falls back when absent. */
  useLlm?: boolean;
}

/** Questions about the workspace itself are answered by the stored overview. */
const ABOUT_PROJECT =
  /\b(what|which|who|describe|explain|overview|purpose|summary|about|status|state|progress|stand|left off|going on|do)\b/i;

/**
 * Does the question point at this workspace, rather than at the world? Without
 * one of these, a low-confidence question is treated as out of scope — which is
 * what stops a small model from inventing a link to whatever it was asked.
 */
const REFERENCES_PROJECT =
  /\b(this|the|my|our|their)\s+(project|repo|repository|codebase|code|app|workspace)\b|\bhere\b|\b(left|leave|leaving|pick(?:ing)?) (off|up)\b|\bworking on\b|\blast (time|session)\b|\bwhere (was|am) i\b|\bcontinue\b|\bnext step/i;

/**
 * Negative premises: "why is this failing?", "what's wrong with the build?".
 * They presume a failure happened. Answering one from a record with no failure
 * in it is how a model invents a cause, so the guard below makes the refusal
 * deterministic instead of leaving it to the model's judgement.
 */
const NEGATIVE_PREMISE =
  /\b(?:why|what(?:'s|s| is| was)?|how come)\b[^?.!]{0,60}?\b(?:fail(?:s|ed|ing|ure)?|broke(?:n)?|breaking|crash(?:es|ed|ing)?|error(?:s|ing)?|wrong|bug(?:s|gy)?|not working|won'?t work|doesn'?t work|does not work|isn'?t working|stopped working|regress(?:ed|ion)?|throw(?:s|ing)?)\b/i;

/**
 * Architecture questions ask how the whole thing is put together. They need a
 * retrieval match that actually reached the record; answered from a distant
 * nearest passage, the model would design a system that is not there.
 */
const ARCHITECTURE_QUESTION =
  /\b(?:architect\w*|design(?:ed|s)?|structured|structure|wired|modular|organi[sz]ed|data ?flow|control flow|pipeline|la(?:id|y) out)\b|\bhow (?:is|are|does|do)\b[^?.!]{0,60}?\b(?:work(?:s)?|built|structured|organi[sz]ed|wired|put together|designed|architected)\b/i;

/**
 * Retrieval fuses lexical and vector ranks, so one strong channel scores about
 * 1/(60+1) ≈ 0.016. An architecture answer must clear that floor, which means
 * the question reached the record rather than a rank-8 near-miss.
 */
export const MIN_ARCHITECTURE_SCORE = 0.015;

/**
 * Small models narrate instead of answering ("The user is asking …", "It seems
 * like you're …"). Strip that throat-clearing rather than shipping it.
 */
const META_NARRATION = [
  /^the user (is asking|wants|asked|wanted|is looking|is trying)[^.!?]*[.!?]\s*/i,
  /^it seems (?:like|that) [^.!?]*[.!?]\s*/i,
  /^you(?: are|'re) (?:asking|trying|looking|considering)[^.!?]*[.!?]\s*/i,
  /^so the user[^.!?]*[.!?]\s*/i,
  /^so,?\s+/i,
  /^the question is[^.!?]*[.!?]\s*/i,
  /^based on the (?:provided )?context,?\s*/i,
  /^from the (?:provided )?context,?\s*/i,
  /^looking at the (?:provided )?context,?\s*/i,
  /^in this context,?\s*/i,
];

/**
 * A chat answer must not narrate its own machinery. This removes leading
 * throat-clearing, drops whole sentences that talk about "the user" or "the
 * context" instead of the project, and strips opening connectives left dangling.
 */
function trimToAnswer(text: string): string {
  let out = text.trim();
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const pattern of META_NARRATION) {
      const next = out.replace(pattern, '').trim();
      if (next !== out && next.length > 0) {
        out = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const sentences = out.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter(
    (line) => !/\b(the user|the question|this question|the context|the provided context)\b/i.test(line),
  );
  if (kept.length > 0) out = kept.join(' ');
  out = out.replace(/^(however|in fact|additionally|moreover|also|that said|so|given that),?\s+/i, '');
  return capitalize(out.trim());
}

/**
 * True when the text still narrates the machinery rather than the project.
 * Used to reject a model answer that is nothing but a restatement, so the
 * composed answer is used instead of shipping the empty shell.
 */
function isMetaNarration(text: string): boolean {
  if (/\b(the user|the question|this question)\b/i.test(text)) return true;
  return META_NARRATION.some((pattern) => pattern.test(text.trim()));
}

function referencesProject(query: string, project: ProjectRow | null): boolean {
  if (REFERENCES_PROJECT.test(query)) return true;
  if (project && project.name.length > 2 && query.toLowerCase().includes(project.name.toLowerCase())) return true;
  return false;
}

const KIND_LABELS: Record<OwnerType, string> = {
  project: 'workspace overview',
  commit: 'commit',
  decision: 'decision',
  chat: 'IDE chat turn',
  event: 'captured shell/file event',
};

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Indexed documents carry their own provenance prefix ("commit <hash> by
 * <author>: <subject>", "decision: <text>"). The panel shows provenance
 * separately, so strip it here or every citation reads twice over.
 */
function humanize(kind: OwnerType, text: string): string {
  const single = oneLine(text);
  if (kind === 'commit' && single.startsWith('commit ')) {
    const cut = single.indexOf(': ');
    if (cut > 0) return single.slice(cut + 2);
  }
  if (kind === 'decision') return single.replace(/^decision:\s*/, '');
  return single;
}

/** Timeline commit lines start with the short hash; drop it when speaking. */
function humanizeTimeline(entry: TimelineEntry): string {
  const text = oneLine(entry.text);
  return entry.kind === 'commit' ? text.replace(/^[0-9a-f]{7,40}\s+/, '') : text;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

function listOf(items: string[], max: number): string {
  const shown = items.slice(0, max);
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** "X is <stored overview>. It is built with A and B." */
function identityParagraph(project: ProjectRow | null, overview: string | null, profile: ProjectProfile | null): string | null {
  if (overview) {
    const stack = profile && profile.stack.length > 0 ? ` It is built with ${listOf(profile.stack, 4)}.` : '';
    return sentence(overview) + stack;
  }
  if (profile && profile.summary) return sentence(profile.summary);
  if (project) return sentence(`${project.name} is a tracked workspace with no stored overview yet`);
  return null;
}

/** Concrete shape: languages, folders, entry points, how tests run. */
function structureParagraph(profile: ProjectProfile | null): string | null {
  if (!profile) return null;
  const bits: string[] = [];
  const languages = profile.languages
    .slice(0, 3)
    .map((entry) => `${entry.language} (${entry.files} files)`);
  if (languages.length > 0) bits.push(`most of the code is ${listOf(languages, 3)}`);
  const folders = profile.topLevel
    .filter((entry) => entry.kind === 'dir')
    .slice(0, 6)
    .map((entry) => entry.name);
  if (folders.length > 0) bits.push(`the main folders are ${listOf(folders, 6)}`);
  if (profile.entryPoints.length > 0) bits.push(`the entry points are ${listOf(profile.entryPoints.slice(0, 3), 3)}`);
  if (profile.testCommand) bits.push(`tests run with ${profile.testCommand}`);
  if (bits.length === 0) return null;
  return sentence(capitalize(bits.join('; ')));
}

/** Where the workspace stands, in one sentence. */
function standingParagraph(newest: TimelineEntry | undefined, counts: string): string {
  if (!newest) return sentence(`Nothing has been captured for it yet, and on record there are ${counts}`);
  return sentence(
    `As of ${relativeTime(newest.ts)} the newest activity was ${humanizeTimeline(newest)}, and on record there are ${counts}`,
  );
}

/** The closest thing on record, said plainly rather than listed. */
function evidenceParagraph(evidence: SearchHit[], query: string): string {
  const top = evidence[0];
  if (!top) return sentence(`Nothing on record speaks to "${truncate(query, 60)}" directly`);
  const lead = `On that, the clearest thing on record is ${article(KIND_LABELS[top.ownerType])} from ${relativeTime(
    top.ts,
  )}: "${truncate(humanize(top.ownerType, top.text), 170)}"`;
  const nearby = evidence
    .slice(1, 3)
    .map((hit) => `${KIND_LABELS[hit.ownerType]} from ${relativeTime(hit.ts)}`);
  const tail = nearby.length > 0 ? ` Close by in the same area: ${listOf(nearby, 2)}.` : '';
  return sentence(lead) + tail;
}

async function safeProfile(db: Db, project: ProjectRow): Promise<ProjectProfile | null> {
  try {
    return await buildProjectProfile(db, project);
  } catch (err) {
    log.debug(`answer: could not profile the workspace — ${String(err)}`);
    return null;
  }
}

/**
 * True when the record itself shows a failure: a command that exited non-zero,
 * or a revert commit. This is what a negative premise is allowed to be answered
 * from; without it there is nothing to diagnose. Scoped to the project when one
 * is selected, otherwise across every captured event.
 */
export function hasFailureEvidence(db: Db, projectId: number | null): boolean {
  const projectFilter = projectId === null ? '' : 'AND project_id = ?';
  const params: unknown[] = projectId === null ? [] : [projectId];
  const failed = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE exit_code != 0 ${projectFilter}`)
    .get(...params) as { n: number };
  if (failed.n > 0) return true;
  const reverts = db
    .prepare(`SELECT COUNT(*) AS n FROM commits WHERE message LIKE '%revert%' ${projectFilter}`)
    .get(...params) as { n: number };
  return reverts.n > 0;
}

/** Why a question cannot be answered from the record, or null when it can. */
export interface EvidenceGap {
  kind: 'negative-premise' | 'architecture';
  reason: string;
}

/**
 * The evidence guard, shared by every surface that answers a question. It is
 * deterministic and DB-only: a negative premise is blocked unless the record
 * shows a failure, and an architecture question is blocked unless retrieval
 * cleared the confidence floor.
 */
export function detectEvidenceGap(
  db: Db,
  projectId: number | null,
  query: string,
  topScore: number,
): EvidenceGap | null {
  if (NEGATIVE_PREMISE.test(query) && !hasFailureEvidence(db, projectId)) {
    return {
      kind: 'negative-premise',
      reason: 'the question presumes a failure, but no failed command (exit_code != 0) or revert is on record',
    };
  }
  if (ARCHITECTURE_QUESTION.test(query) && topScore < MIN_ARCHITECTURE_SCORE) {
    return {
      kind: 'architecture',
      reason: `an architecture question needs a retrieval score of at least ${MIN_ARCHITECTURE_SCORE}, but the best passage scored ${topScore.toFixed(3)}`,
    };
  }
  return null;
}

export async function answerQuestion(db: Db, config: BrainConfig, input: AnswerInput): Promise<GroundedAnswer> {
  const query = input.query.trim();
  const project = input.project;
  const overview = project?.summary?.trim() || null;
  // Retrieval decides how much licence the answer has: a question that neither
  // names the workspace nor matched anything is out of scope, and is refused
  // rather than answered from whatever happened to rank highest.
  const onTopic = referencesProject(query, project) || !input.weak;
  const about = ABOUT_PROJECT.test(query) && onTopic;

  const sources: AnswerSource[] = input.hits.slice(0, 6).map((hit) => ({
    kind: hit.ownerType,
    project: hit.projectName,
    ts: hit.ts,
    snippet: truncate(humanize(hit.ownerType, hit.text), 220),
  }));

  // The evidence guard. A negative premise presumes a failure; with no captured
  // failure and no revert there is nothing to diagnose, so the question is
  // refused rather than handed to a model that would conjure a cause. An
  // architecture question is likewise only attempted once retrieval is strong
  // enough to ground it. Both refusals are on the record, not the model, so no
  // LLM is consulted either way.
  const topScore = input.hits[0]?.score ?? 0;
  const gap = detectEvidenceGap(db, project ? project.id : null, query, topScore);
  if (gap) {
    const scope = project ? `this workspace (${project.name})` : 'your recorded history';
    const text =
      gap.kind === 'negative-premise'
        ? sentence(
            `Nothing in ${scope} shows a failure: no command exited non-zero and no revert was captured, so there is no recorded problem behind "${truncate(query, 60)}" to explain`,
          )
        : sentence(
            `Answering how ${project ? project.name : 'this'} is built needs a firmer match than "${truncate(query, 60)}" found — the closest recorded passages are too loose to ground an architecture answer, and guessing at one would be invention`,
          );
    return {
      text,
      generator: 'insufficient-evidence',
      partial: true,
      sources,
      llm: { used: false, model: config.llm.model, reason: gap.reason },
    };
  }

  // Evidence the citations show. The workspace-overview passage is dropped when
  // a stored overview exists, because that overview is what the answer explains
  // with — otherwise every answer would cite itself.
  const evidence = input.hits.filter((hit) => !(hit.ownerType === 'project' && overview !== null)).slice(0, 4);

  const newest = buildTimeline(db, { projectId: project ? project.id : null, limit: 1 })[0];
  // countCommits is per-project, so an unscoped answer sums across workspaces.
  const commitCount = project
    ? countCommits(db, project.id)
    : listProjects(db).reduce((sum, row) => sum + countCommits(db, row.id), 0);
  const counts = [
    plural(commitCount, 'commit'),
    plural(countDecisions(db, project ? project.id : null), 'decision'),
    plural(countEvents(db, project ? project.id : null), 'captured event'),
    plural(countChatTurns(db, project ? project.id : null), 'chat turn'),
  ].join(', ');

  const profile = project && (overview === null || about) ? await safeProfile(db, project) : null;

  const paragraphs: string[] = [];
  const identity = identityParagraph(project, overview, profile);
  const structure = structureParagraph(profile);
  if (onTopic) {
    if (identity) paragraphs.push(identity);
    if (structure) paragraphs.push(structure);
    if (!about && evidence.length > 0) paragraphs.push(evidenceParagraph(evidence, query));
  } else {
    paragraphs.push(
      sentence(`Nothing in the recorded history of this workspace covers "${truncate(query, 70)}"`),
    );
  }
  paragraphs.push(standingParagraph(newest, counts));

  const llm: GroundedAnswer['llm'] = { used: false, model: config.llm.model };
  let generator: GroundedAnswer['generator'] = overview && about ? 'stored-overview' : 'captured-history';

  if (!onTopic) {
    llm.reason = 'the question did not match any recorded history, so no model was asked';
  } else if ((input.useLlm ?? true) && config.llm.provider !== 'none') {
    const models = await listOllamaModels(config.llm.ollamaUrl);
    if (models === null) {
      llm.reason = `Ollama not reachable at ${config.llm.ollamaUrl}`;
    } else if (!hasOllamaModel(models, config.llm.model)) {
      llm.reason = `model "${config.llm.model}" is not installed — run: ollama pull ${config.llm.model}`;
    } else {
      // Send the tag that is actually installed ("llama3.2:1b"), not the bare
      // config name, which Ollama would resolve to a missing ":latest".
      const installed = resolveOllamaModel(models, config.llm.model) ?? config.llm.model;
      llm.model = installed;
      const client = createOllamaLlm({
        url: config.llm.ollamaUrl,
        model: installed,
        timeoutMs: config.llm.timeoutMs,
      });
      const context = [
        project ? `Workspace: ${project.name}` : 'Workspace: all projects',
        overview ? `Stored overview: ${overview}` : '',
        structure ? `Codebase: ${structure}` : '',
        newest ? `Most recent activity (${relativeTime(newest.ts)}): ${humanizeTimeline(newest)}` : '',
        `On record: ${counts}`,
        ...evidence.map((hit) => `${KIND_LABELS[hit.ownerType]} (${relativeTime(hit.ts)}): ${humanize(hit.ownerType, hit.text)}`),
      ]
        .filter((line) => line.length > 0)
        .join('\n');
      const subject = project
        ? `The user is asking about one of their software projects, named "${project.name}". "This project" means that one.`
        : 'The user is asking about their captured history across all of their software projects.';
      const retrievalNote = input.weak
        ? '\nRetrieval note: search confidence for this question is low and the passages below are only loosely related. If the question is not about this project or its recorded history, say plainly that you have nothing recorded on it.'
        : '';
      const generated = await client.generate(
        `${subject}${retrievalNote}\n\nContext:\n${context}\n\nQuestion: ${query}\n\nAnswer:`,
        {
          system:
            'You are the recall layer of a local second brain, answering questions about the user\'s own software project. ' +
            'Write plain, conversational prose like a knowledgeable teammate: 3 to 5 sentences, no bullet lists, no raw commit hashes, and refer to the project by its name. ' +
            'Start straight in with the answer, the way a teammate would: never open with "The user is asking", "It seems like", "So", "Based on the context", or a restatement of the question. ' +
            'Ground every fact in the context, but you may explain what the context implies, connect the dots, and reason a step or two beyond it when the question calls for judgement. ' +
            'If the question assumes something the context does not support, say so plainly instead of playing along. ' +
            'If the question is unrelated to this project, or is not intelligible, say you have nothing recorded on it — do not invent a connection. ' +
            'Never invent files, dates, technologies, people or numbers that are not in the context.',
          temperature: 0.35,
          maxTokens: 450,
        },
      );
      const written = trimToAnswer(generated);
      // A small model sometimes answers with nothing but a restatement of the
      // question. When that happens the composed answer is strictly better, so
      // keep it instead of shipping the empty shell.
      if (written.length >= 50 && !isMetaNarration(written)) {
        // The model writes the answer; the evidence stays as the footnotes. The
        // deterministic state line is only kept when the model did not already
        // say the same thing, so answers do not end in an echo.
        const alreadySaid =
          newest !== undefined &&
          written.toLowerCase().includes(humanizeTimeline(newest).toLowerCase().slice(0, 24));
        paragraphs.splice(0, paragraphs.length, written);
        if (!alreadySaid) paragraphs.push(standingParagraph(newest, counts));
        generator = 'local-model';
        llm.used = true;
      } else {
        llm.reason =
          generated.trim().length > 0
            ? 'the model only restated the question, so the composed answer was kept'
            : 'the model returned an empty response';
      }
    }
    if (!llm.used) log.debug(`answer: model skipped — ${llm.reason ?? 'unknown reason'}`);
  } else if (!(input.useLlm ?? true)) {
    llm.reason = 'disabled for this request';
  }

  return {
    text: paragraphs.filter((part) => part.trim().length > 0).join('\n\n'),
    generator,
    partial: !llm.used,
    sources,
    llm,
  };
}
