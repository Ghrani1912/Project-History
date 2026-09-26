import type { Db } from '../db/index.js';
import { parseCommitFiles } from './commits.js';
import { listProjects } from './projects.js';
import type { DecisionRow, ProjectRow } from './types.js';
import { tokenize } from '../embeddings/embedder.js';
import { capabilitiesOf } from './priorart.js';

/**
 * "Before you commit to that: you tried it in March and rejected it because X."
 *
 * Past decisions are the most expensive knowledge you own — they encode a
 * question you already answered. This module diffs a *proposal* against them
 * semantically (rare shared vocabulary + problem shape), separates decisions
 * you accepted from ones you rejected, and treats `Revert "..."` commits as
 * evidence of something you tried and backed out of.
 */

export type Verdict = 'rejected-before' | 'decided-before' | 'related' | 'clear';

export interface PastDecision {
  id: number;
  source: 'decision' | 'revert';
  projectId: number | null;
  projectName: string | null;
  ts: number;
  text: string;
  /** "you rejected it because …" when the entry carries a reason. */
  reason: string | null;
  tags: string[];
  status: 'accepted' | 'rejected';
  score: number;
  sharedCapabilities: string[];
  sharedWords: string[];
  /** The commit a revert came from, for `git show`. */
  hash: string | null;
}

export interface PreflightResult {
  proposal: string;
  verdict: Verdict;
  findings: PastDecision[];
  /** Best score that did not clear the bar, so an empty result can be judged. */
  bestRejectedScore: number;
  considered: number;
}

export interface PreflightOptions {
  /** Look in this project only; omit to look everywhere. */
  projectId?: number | null;
  limit?: number;
  minScore?: number;
  /** How many decisions per project to consider. */
  decisionsPerProject?: number;
}

const REJECTION_WORDS =
  /\b(rejected|rejects|reverted|revert|rolled? (?:this |it )?back|rollback|abandoned|backed out|backed away|decided against|decided not|do not use|don't use|dropped|removed the|scrapped|tried and|didn't work|did not work|failed because|waste)\b/i;

const REVERT_SUBJECT = /^(revert|rollback|undo|back out|revert:)/i;

const REASON_SPLIT = /\b(?:because|since|due to|as|so that|reason:|because of)\b/i;

/** How specific a capability is: the same table the prior-art matcher uses. */
const SPECIFIC_CAPABILITY = new Set([
  'auth/session',
  'realtime/streaming',
  'ml/model',
  'graph/topology',
  'notifications',
  'retry/errors',
  'caching/perf',
  'data/ingestion',
]);

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'that',
  'this',
  'then',
  'than',
  'use',
  'used',
  'using',
  'instead',
  'because',
  'since',
  'will',
  'would',
  'should',
  'could',
  'decided',
  'decision',
  'rejected',
  'revert',
  'reverted',
  'add',
  'added',
  'adding',
  'remove',
  'removed',
  'change',
  'changed',
  'changes',
  'switch',
  'switched',
  'tried',
  'try',
  'make',
  'made',
  'keep',
  'kept',
  'not',
  'but',
  'all',
  'any',
  'new',
  'old',
  'more',
  'less',
  'app',
  'api',
  'code',
  'file',
  'files',
  'project',
  'feature',
]);

function words(text: string): string[] {
  const out: string[] = [];
  for (const token of tokenize(text)) {
    if (token.length < 3 || STOPWORDS.has(token) || /^\d+$/.test(token)) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

function capabilities(text: string): string[] {
  return capabilitiesOf(text).filter((tag) => SPECIFIC_CAPABILITY.has(tag));
}

function splitReason(text: string): string | null {
  const match = REASON_SPLIT.exec(text);
  if (!match || match.index === undefined) return null;
  const reason = text.slice(match.index + match[0].length).trim();
  return reason.length >= 3 ? reason : null;
}

/** Decisions that say "we rejected X" are far more valuable than approvals. */
export function decisionStatus(text: string, tags: string[] = []): 'accepted' | 'rejected' {
  if (REJECTION_WORDS.test(text)) return 'rejected';
  if (tags.some((tag) => /reject|revert|abandon|rollback/i.test(tag))) return 'rejected';
  return 'accepted';
}

interface Candidate {
  id: number;
  source: 'decision' | 'revert';
  projectId: number | null;
  projectName: string | null;
  ts: number;
  text: string;
  reason: string | null;
  tags: string[];
  status: 'accepted' | 'rejected';
  hash: string | null;
  words: string[];
  capabilities: string[];
}

function collectCandidates(db: Db, options: PreflightOptions): Candidate[] {
  const out: Candidate[] = [];
  const perProject = options.decisionsPerProject ?? 200;
  const projectNames = new Map<number, string>(listProjects(db).map((project) => [project.id, project.name]));
  const scope: ProjectRow[] = listProjects(db).filter(
    (project) => options.projectId === undefined || options.projectId === null || project.id === options.projectId,
  );

  for (const project of scope) {
    const decisions = db
      .prepare('SELECT * FROM decisions WHERE project_id = ? OR project_id IS NULL ORDER BY ts DESC LIMIT ?')
      .all(project.id, perProject) as DecisionRow[];
    for (const decision of decisions) {
      const tags = (decision.tags ?? '').split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0);
      out.push({
        id: decision.id,
        source: 'decision',
        projectId: decision.project_id,
        projectName: decision.project_id === null ? null : projectNames.get(decision.project_id) ?? null,
        ts: decision.ts,
        text: decision.text,
        reason: splitReason(decision.text),
        tags,
        status: decisionStatus(decision.text, tags),
        hash: null,
        words: words(decision.text),
        capabilities: capabilities(decision.text),
      });
    }

    // Commits that undo earlier work are the same signal, written by git.
    const commits = db
      .prepare('SELECT hash, message, ts, files FROM commits WHERE project_id = ? ORDER BY ts DESC LIMIT 400')
      .all(project.id) as Array<{ hash: string; message: string | null; ts: number; files: string | null }>;
    for (const commit of commits) {
      const subject = (commit.message ?? '').split('\n')[0]?.trim() ?? '';
      const body = commit.message ?? '';
      const isRevert = REVERT_SUBJECT.test(subject) || /\brevert(s|ed|ing)?\b/i.test(subject);
      if (!isRevert) continue;
      const files = parseCommitFiles(commit.files).map((file) => file.path);
      const text = `${subject} ${files.join(' ')}`.trim();
      out.push({
        id: 0,
        source: 'revert',
        projectId: project.id,
        projectName: project.name,
        ts: commit.ts,
        text,
        reason: splitReason(body.replace(/\n/g, ' ')) ?? null,
        tags: [],
        status: 'rejected',
        hash: commit.hash,
        words: words(text),
        capabilities: capabilities(text),
      });
    }
  }
  return out;
}

function inverseDocumentFrequency(sets: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const set of sets) {
    for (const item of new Set(set)) df.set(item, (df.get(item) ?? 0) + 1);
  }
  const total = Math.max(1, sets.length);
  const idf = new Map<string, number>();
  for (const [item, count] of df) idf.set(item, Math.log(1 + total / count));
  return idf;
}

/**
 * Compare a proposal against everything you have already decided.
 * Returns the conflicting history, strongest first, and a verdict.
 */
export function checkProposal(db: Db, proposal: string, options: PreflightOptions = {}): PreflightResult {
  const limit = options.limit ?? 4;
  const minScore = options.minScore ?? 1.5;
  const candidates = collectCandidates(db, options);
  const wordIdf = inverseDocumentFrequency(candidates.map((candidate) => candidate.words));
  const capabilityIdf = inverseDocumentFrequency(candidates.map((candidate) => candidate.capabilities));
  const proposalWords = words(proposal);
  const proposalCapabilities = capabilities(proposal);

  const findings: PastDecision[] = [];
  let bestRejectedScore = 0;

  for (const candidate of candidates) {
    const sharedWords = candidate.words.filter((word) => proposalWords.includes(word));
    const sharedCapabilities = candidate.capabilities.filter((tag) => proposalCapabilities.includes(tag));
    let score = 0;
    for (const tag of sharedCapabilities) score += (capabilityIdf.get(tag) ?? 1) * 1.5;
    for (const word of sharedWords.slice(0, 6)) score += Math.min(wordIdf.get(word) ?? 0, 2);
    if (sharedCapabilities.length >= 2) score += 0.4;
    if (score > bestRejectedScore) bestRejectedScore = score;
    // One shared word is a coincidence; require shape or a real overlap.
    const informative =
      sharedCapabilities.length > 0 || sharedWords.length >= 2 || sharedWords.some((word) => (wordIdf.get(word) ?? 0) >= 1.6);
    if (score < minScore || !informative) continue;
    findings.push({
      id: candidate.id,
      source: candidate.source,
      projectId: candidate.projectId,
      projectName: candidate.projectName,
      ts: candidate.ts,
      text: candidate.text,
      reason: candidate.reason,
      tags: candidate.tags,
      status: candidate.status,
      score: Math.round(score * 100) / 100,
      sharedCapabilities,
      sharedWords: sharedWords.slice(0, 5),
      hash: candidate.hash,
    });
  }

  findings.sort((a, b) => b.score - a.score || b.ts - a.ts);
  const top = findings.slice(0, limit);
  let verdict: Verdict = 'clear';
  if (top.some((finding) => finding.status === 'rejected')) verdict = 'rejected-before';
  else if (top.length > 0) verdict = top[0] && top[0].score >= minScore * 1.5 ? 'decided-before' : 'related';

  return {
    proposal,
    verdict,
    findings: top,
    bestRejectedScore: Math.round(bestRejectedScore * 100) / 100,
    considered: candidates.length,
  };
}

/** One line explaining why a past decision is relevant to the proposal. */
export function explainFinding(finding: PastDecision): string {
  const parts: string[] = [];
  if (finding.sharedCapabilities.length > 0) parts.push(`same area: ${finding.sharedCapabilities.join(', ')}`);
  if (finding.sharedWords.length > 0) parts.push(`overlapping words: ${finding.sharedWords.join(', ')}`);
  return parts.join(' · ');
}
