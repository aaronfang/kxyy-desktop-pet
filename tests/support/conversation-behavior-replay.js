export const BEHAVIOR_SCENARIO = Object.freeze({
  SHORT_ACKNOWLEDGEMENT: "short-acknowledgement",
  OPINION_REQUEST: "opinion-request",
  VULNERABLE_DISCLOSURE: "vulnerable-disclosure",
  REPEATED_AGREEMENT: "repeated-agreement",
  LED_TOPIC_REJECTION: "led-topic-rejection",
});

export const PERSONA_STANCE = Object.freeze({
  NEUTRAL: "neutral",
  SUPPORT: "support",
  OPINION: "opinion",
  CONTRAST: "contrast",
  LEAD: "lead",
});

const SCENARIOS = new Set(Object.values(BEHAVIOR_SCENARIO));
const MAX_SOURCE_TURNS = 64;
const MAX_REPLAY_TURNS = 32;
const MAX_REPLY_CHARS = 280;
const MAX_TOPIC_TERMS = 4;
const GENERIC_AGREEMENT_RE = /^(?:哈+|嗯+|对(?:啊|呀)?|确实|没错|我明白|我懂)[，。！!、\s]*/u;
const SUPPORT_RE = /听起来|先别急|不用逼自己|挺难受|不容易|我能理解/u;
const OPINION_RE = /我觉得|我的看法|我更倾向|我会选|我不太看好/u;
const CONTRAST_RE = /不过|但我不|不完全同意|换个角度|未必|不一定/u;
const LEAD_RE = /我倒想到|换我来|我先说|我来起个头|我有个主意/u;

function boundedString(value, maximum) {
  if (typeof value !== "string") return null;
  const chars = Array.from(value.trim());
  if (!chars.length || chars.length > maximum) return null;
  return chars.join("");
}

function sanitizeTurn(value) {
  if (!value || typeof value !== "object" || !SCENARIOS.has(value.scenario)) return null;
  const reply = boundedString(value.reply, MAX_REPLY_CHARS);
  if (!reply) return null;
  const sourceTerms = Array.isArray(value.userTopicTerms) ? value.userTopicTerms : [];
  if (sourceTerms.length > MAX_TOPIC_TERMS) return null;
  const userTopicTerms = [];
  for (const term of sourceTerms) {
    const safe = boundedString(term, 16);
    if (!safe) return null;
    userTopicTerms.push(safe);
  }
  return { scenario: value.scenario, reply, userTopicTerms };
}

function classifyPersonaStance(reply) {
  if (SUPPORT_RE.test(reply)) return PERSONA_STANCE.SUPPORT;
  if (OPINION_RE.test(reply)) return PERSONA_STANCE.OPINION;
  if (CONTRAST_RE.test(reply)) return PERSONA_STANCE.CONTRAST;
  if (LEAD_RE.test(reply)) return PERSONA_STANCE.LEAD;
  return PERSONA_STANCE.NEUTRAL;
}

function hasContribution(reply) {
  const statements = (reply.match(/[^。！？!?]+[。！？!?]?/gu) || [])
    .filter((sentence) => !/[？?]$/u.test(sentence));
  return statements.some((statement) => {
    const normalized = statement.replace(GENERIC_AGREEMENT_RE, "").replace(/[\p{P}\s]/gu, "");
    return Array.from(normalized).length >= 12;
  });
}

function observeTurn(turn) {
  const questionCount = (turn.reply.match(/[？?]/gu) || []).length;
  const personaStance = classifyPersonaStance(turn.reply);
  const contribution = hasContribution(turn.reply);
  const followedUserTopic = turn.scenario === BEHAVIOR_SCENARIO.LED_TOPIC_REJECTION &&
    turn.userTopicTerms.length > 0 &&
    turn.userTopicTerms.some((term) => turn.reply.includes(term));
  return {
    scenario: turn.scenario,
    contribution,
    questionCount,
    personaStance,
    followedUserTopic,
  };
}

function passesScenario(observation) {
  if (!observation.contribution || observation.questionCount > 1) return false;
  switch (observation.scenario) {
    case BEHAVIOR_SCENARIO.SHORT_ACKNOWLEDGEMENT:
      return true;
    case BEHAVIOR_SCENARIO.OPINION_REQUEST:
      return observation.personaStance === PERSONA_STANCE.OPINION;
    case BEHAVIOR_SCENARIO.VULNERABLE_DISCLOSURE:
      return observation.personaStance === PERSONA_STANCE.SUPPORT;
    case BEHAVIOR_SCENARIO.REPEATED_AGREEMENT:
      return [PERSONA_STANCE.CONTRAST, PERSONA_STANCE.LEAD].includes(
        observation.personaStance,
      );
    case BEHAVIOR_SCENARIO.LED_TOPIC_REJECTION:
      return observation.followedUserTopic && observation.personaStance !== PERSONA_STANCE.LEAD;
    default:
      return false;
  }
}

export function evaluateConversationBehaviorReplay(source) {
  const input = Array.isArray(source) ? source : [];
  const observations = [];
  let rejected = Math.max(0, input.length - MAX_SOURCE_TURNS);
  let truncated = 0;
  for (const value of input.slice(0, MAX_SOURCE_TURNS)) {
    const turn = sanitizeTurn(value);
    if (!turn) rejected += 1;
    else if (observations.length < MAX_REPLAY_TURNS) observations.push(observeTurn(turn));
    else truncated += 1;
  }
  const counts = {
    turns: observations.length,
    contribution: 0,
    question: 0,
    support: 0,
    opinion: 0,
    contrast: 0,
    lead: 0,
    followedUserTopic: 0,
    rejected,
    truncated,
  };
  const scenarios = observations.map((observation) => {
    if (observation.contribution) counts.contribution += 1;
    counts.question += observation.questionCount;
    if (observation.personaStance !== PERSONA_STANCE.NEUTRAL) {
      counts[observation.personaStance] += 1;
    }
    if (observation.followedUserTopic) counts.followedUserTopic += 1;
    return { ...observation, pass: passesScenario(observation) };
  });
  const covered = new Set(scenarios.map(({ scenario }) => scenario));
  return {
    pass: SCENARIOS.size === covered.size && scenarios.every(({ pass }) => pass),
    counts,
    scenarios,
  };
}
