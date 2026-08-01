/**
 * Reply classification abstraction. Pure module — no I/O.
 *
 * Maps inbound reply text to the spec's twelve categories with a transparent
 * rule-based classifier, and defines the routing rules each category triggers.
 * Safety-critical precedence: opt-out, complaint, and sensitive matches are
 * checked before anything else and can never be overridden by a softer match.
 */

export const REPLY_CATEGORIES = [
  "interested",
  "wants_appointment",
  "needs_more_information",
  "not_ready",
  "follow_up_later",
  "already_hired",
  "wrong_person",
  "not_interested",
  "opt_out",
  "complaint",
  "sensitive",
  "unknown",
] as const;

export type ReplyCategory = (typeof REPLY_CATEGORIES)[number];

export const REPLY_CATEGORY_LABELS: Record<ReplyCategory, string> = {
  interested: "Interested",
  wants_appointment: "Wants appointment",
  needs_more_information: "Needs more information",
  not_ready: "Not ready",
  follow_up_later: "Follow up later",
  already_hired: "Already hired someone",
  wrong_person: "Wrong person",
  not_interested: "Not interested",
  opt_out: "Opt out",
  complaint: "Complaint",
  sensitive: "Sensitive",
  unknown: "Unknown",
};

export function isReplyCategory(value: string): value is ReplyCategory {
  return (REPLY_CATEGORIES as readonly string[]).includes(value);
}

export type ReplyClassification = {
  category: ReplyCategory;
  confidence: number;
  matched: string | null;
};

/** Ordered pattern table — first category whose pattern matches wins. Order encodes safety precedence. */
const PATTERN_TABLE: Array<{ category: ReplyCategory; confidence: number; patterns: RegExp[] }> = [
  {
    category: "opt_out",
    confidence: 0.98,
    patterns: [
      /\bstop\b/i,
      /\bunsubscribe\b/i,
      /\bopt\s*(?:me\s*)?out\b/i,
      /\bremove\s+(?:me|us|my\s+(?:number|email))\b/i,
      /\b(?:don'?t|do\s+not|never)\s+(?:contact|text|message|email|call)\s+(?:me|us)\b/i,
      /\btake\s+me\s+off\b/i,
      /\bno\s+more\s+(?:texts|messages|emails|calls)\b/i,
      /\bleave\s+(?:me|us)\s+alone\b/i,
    ],
  },
  {
    category: "complaint",
    confidence: 0.95,
    patterns: [
      /\b(?:harass|harassment|harassing)\b/i,
      /\b(?:attorney|lawyer|legal\s+action|sue|suing|lawsuit)\b/i,
      /\breport(?:ing)?\s+(?:you|this|spam)\b/i,
      /\bspam(?:ming)?\b/i,
      /\bbetter\s+business\s+bureau\b/i,
      /\bfcc\b/i,
      /\bhow\s+did\s+you\s+get\s+(?:my|this)\s+(?:number|email)\b/i,
    ],
  },
  {
    category: "sensitive",
    confidence: 0.9,
    patterns: [
      /\b(?:passed\s+away|deceased|died|funeral)\b/i,
      /\b(?:hospital|hospice|cancer|surgery)\b/i,
      /\b(?:divorce|separated\s+from)\b/i,
      /\b(?:lost\s+(?:my|his|her|our)\s+job|laid\s+off|bankruptcy|foreclosure)\b/i,
    ],
  },
  {
    category: "wants_appointment",
    confidence: 0.85,
    patterns: [
      /\b(?:schedule|book|set\s*up)\b.{0,40}\b(?:appointment|estimate|visit|inspection|time|call)\b/i,
      /\bappointment\b/i,
      /\bcome\s+(?:out|by|over)\b/i,
      /\bwhen\s+(?:can|could)\s+(?:you|someone)\b/i,
      /\b(?:available|free)\s+(?:on|this|next)\b/i,
    ],
  },
  {
    category: "already_hired",
    confidence: 0.85,
    patterns: [
      /\b(?:went\s+with|hired|chose|used)\s+(?:someone|another|a\s+different)\b/i,
      /\balready\s+(?:done|finished|completed|hired|had\s+it\s+done|replaced)\b/i,
      /\b(?:someone|somebody)\s+else\s+(?:did|is\s+doing|got)\b/i,
      /\bwork\s+(?:is|was)\s+(?:already\s+)?(?:done|completed)\b/i,
    ],
  },
  {
    category: "wrong_person",
    confidence: 0.85,
    patterns: [
      /\bwrong\s+(?:number|person|email)\b/i,
      /\bnot\s+(?:my|our)\s+(?:number|house|property|project)\b/i,
      /\byou\s+have\s+the\s+wrong\b/i,
      /\bnever\s+(?:contacted|inquired|requested)\b/i,
      /\bwho\s+is\s+this\b/i,
    ],
  },
  {
    category: "not_interested",
    confidence: 0.85,
    patterns: [
      /\b(?:not|no\s+longer)\s+interested\b/i,
      /\bno\s+thanks?\b/i,
      /\bnot\s+for\s+(?:me|us)\b/i,
      /\bplease\s+don'?t\b/i,
      /\bwe(?:'re|\s+are)\s+(?:good|all\s+set|fine)\b/i,
    ],
  },
  {
    category: "follow_up_later",
    confidence: 0.8,
    patterns: [
      /\b(?:follow\s*up|check\s+back|reach\s+out|contact\s+me|call\s+me|try\s+(?:me|again))\b.{0,30}\b(?:later|next|in\s+\d|spring|summer|fall|winter|month|year)\b/i,
      /\b(?:next|in\s+the)\s+(?:month|year|spring|summer|fall|winter|quarter)\b/i,
      /\bin\s+a\s+few\s+(?:weeks|months)\b/i,
      /\bafter\s+(?:the\s+)?(?:holidays|new\s+year|season)\b/i,
    ],
  },
  {
    category: "not_ready",
    confidence: 0.75,
    patterns: [
      /\bnot\s+(?:ready|yet|right\s+now|at\s+this\s+time)\b/i,
      /\b(?:maybe|possibly)\s+(?:later|down\s+the\s+road|in\s+the\s+future)\b/i,
      /\bstill\s+(?:thinking|deciding|saving)\b/i,
      /\bon\s+hold\b/i,
    ],
  },
  {
    category: "needs_more_information",
    confidence: 0.75,
    patterns: [
      /\bhow\s+much\b/i,
      /\b(?:price|pricing|cost|quote|ballpark)\b/i,
      /\bmore\s+(?:info|information|details)\b/i,
      /\bwhat\s+(?:do|would|does|are)\b/i,
      /\bcan\s+you\s+(?:send|tell|explain)\b/i,
      /\bdo\s+you\s+(?:offer|do|handle|finance)\b/i,
    ],
  },
  {
    category: "interested",
    confidence: 0.8,
    patterns: [
      /\b(?:yes|yeah|yep|sure|absolutely|definitely)\b/i,
      /\bstill\s+(?:interested|need|want)\b/i,
      /\bsounds\s+good\b/i,
      /\blet'?s\s+(?:do\s+it|talk|go)\b/i,
      /\b(?:please\s+)?(?:call|text|email)\s+me\b/i,
      /\bi(?:'m|\s+am)\s+interested\b/i,
      /\bgood\s+timing\b/i,
    ],
  },
];

/** Classifies inbound reply text. Deterministic, ordered, and explainable. */
export function classifyReply(text: string): ReplyClassification {
  const trimmed = text.trim();
  if (!trimmed) return { category: "unknown", confidence: 0, matched: null };
  for (const entry of PATTERN_TABLE) {
    for (const pattern of entry.patterns) {
      const match = trimmed.match(pattern);
      if (match) return { category: entry.category, confidence: entry.confidence, matched: match[0] };
    }
  }
  return { category: "unknown", confidence: 0, matched: null };
}

/** What each reply category triggers (spec Part 16). Applied server-side by the reply service. */
export type ReplyRouting = {
  /** Immediately and unconditionally suppress the contact (opt-out). Never gated by anything. */
  suppress: boolean;
  /** Stop automation for this campaign only ('campaign'), all campaigns ('all'), or none. */
  stopAutomation: "none" | "campaign" | "all";
  /** Notify the assigned salesperson (activity + task addressed to them). */
  notifyAssignee: boolean;
  /** Escalate to managers for human review. */
  escalate: boolean;
  /** Create a follow-up task; dueInDays null = due now. */
  task: { title: string; dueInDays: number | null; source: "reply_rule" | "escalation" } | null;
  /** Pipeline stage to move the lead to (only forward-moving; never overrides won/lost/suppressed). */
  setStage: "replied" | "qualified" | "lost" | null;
};

export const REPLY_ROUTING: Record<ReplyCategory, ReplyRouting> = {
  interested: {
    suppress: false, stopAutomation: "campaign", notifyAssignee: true, escalate: false,
    task: { title: "Hot reply — contact this lead now", dueInDays: null, source: "reply_rule" }, setStage: "qualified",
  },
  wants_appointment: {
    suppress: false, stopAutomation: "campaign", notifyAssignee: true, escalate: false,
    task: { title: "Begin scheduling — lead asked for an appointment", dueInDays: null, source: "reply_rule" }, setStage: "qualified",
  },
  needs_more_information: {
    suppress: false, stopAutomation: "campaign", notifyAssignee: true, escalate: false,
    task: { title: "Prepare a human-reviewed response with the requested information", dueInDays: 1, source: "reply_rule" }, setStage: "replied",
  },
  not_ready: {
    suppress: false, stopAutomation: "campaign", notifyAssignee: false, escalate: false,
    task: { title: "Check back in — lead not ready yet", dueInDays: 30, source: "reply_rule" }, setStage: "replied",
  },
  follow_up_later: {
    suppress: false, stopAutomation: "campaign", notifyAssignee: false, escalate: false,
    task: { title: "Scheduled follow-up — lead asked to be contacted later", dueInDays: 30, source: "reply_rule" }, setStage: "replied",
  },
  already_hired: {
    suppress: false, stopAutomation: "all", notifyAssignee: false, escalate: false,
    task: null, setStage: "lost",
  },
  wrong_person: {
    suppress: false, stopAutomation: "all", notifyAssignee: false, escalate: false,
    task: { title: "Verify contact info — reply says wrong person", dueInDays: 2, source: "reply_rule" }, setStage: "replied",
  },
  not_interested: {
    suppress: false, stopAutomation: "campaign", notifyAssignee: false, escalate: false,
    task: null, setStage: "lost",
  },
  opt_out: {
    suppress: true, stopAutomation: "all", notifyAssignee: false, escalate: false,
    task: null, setStage: null, // stage becomes 'suppressed' via the suppression path
  },
  complaint: {
    suppress: false, stopAutomation: "all", notifyAssignee: false, escalate: true,
    task: { title: "Complaint received — human follow-up required", dueInDays: null, source: "escalation" }, setStage: "replied",
  },
  sensitive: {
    suppress: false, stopAutomation: "all", notifyAssignee: false, escalate: true,
    task: { title: "Sensitive reply — human review required before any contact", dueInDays: null, source: "escalation" }, setStage: "replied",
  },
  unknown: {
    suppress: false, stopAutomation: "none", notifyAssignee: false, escalate: false,
    task: { title: "Unclassified reply — human review needed", dueInDays: 1, source: "reply_rule" }, setStage: "replied",
  },
};
