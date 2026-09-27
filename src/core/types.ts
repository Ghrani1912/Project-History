export type EventType = 'cmd' | 'file' | 'commit' | 'chat' | 'decision' | 'error';

/**
 * Things that can be indexed for recall. `project` is the per-project overview
 * document (README, stack, layout), which is what makes "what does this project
 * do?" answerable instead of returning the vaguest commit message.
 */
export type OwnerType = 'decision' | 'commit' | 'chat' | 'event' | 'project';

export interface ProjectRow {
  id: number;
  name: string;
  path: string;
  created_at: number;
  last_seen_at: number | null;
  git_remote: string | null;
  stack: string | null;
  summary: string | null;
  open_threads: string | null;
  ignored: number;
}

export interface EventRow {
  id: number;
  project_id: number | null;
  type: EventType;
  payload: string;
  exit_code: number | null;
  ts: number;
  source: string;
  session_id: string | null;
}

export interface CommitRow {
  id: number;
  project_id: number;
  hash: string;
  author: string | null;
  message: string | null;
  files_changed: number;
  insertions: number;
  deletions: number;
  files: string | null;
  ts: number;
}

export interface DecisionRow {
  id: number;
  project_id: number | null;
  text: string;
  tags: string | null;
  source: string | null;
  ts: number;
}

export interface ChatTurnRow {
  id: number;
  project_id: number | null;
  source_ide: string;
  role: string;
  text: string;
  ts: number;
  source_ref: string | null;
}

export interface BriefRow {
  id: number;
  project_id: number;
  summary_text: string;
  generated_at: number;
  event_watermark: number | null;
  generator: string | null;
}

/** Kinds that can appear on the merged timeline. */
export type TimelineKind = 'cmd' | 'file' | 'commit' | 'chat' | 'decision' | 'error';

/** A normalised timeline entry merged across every capture source. */
export interface TimelineEntry {
  kind: TimelineKind;
  ts: number;
  projectId: number | null;
  text: string;
  detail?: string;
  source: string;
  refId: number;
}

export interface ContradictionRow {
  id: number;
  project_id: number | null;
  a_id: number;
  b_id: number;
  category: string;
  choice_a: string;
  choice_b: string;
  score: number;
  reason: string;
  detected_at: number;
  dismissed: number;
}

export interface SearchHit {
  ownerType: OwnerType;
  ownerId: number;
  projectId: number | null;
  projectName: string | null;
  ts: number;
  text: string;
  score: number;
  /** Which retrieval strategies matched — useful for debugging recall quality. */
  via: Array<'vector' | 'lexical'>;
}
