export function routeMemoryTopics(chunks = [], { maxTopics = 64, maxPerTopic = 64 } = {}) {
  const topics = new Map();
  for (const chunk of Array.isArray(chunks) ? chunks.slice(0, 256) : []) {
    const labels = Array.isArray(chunk?.topics) ? chunk.topics : (chunk?.topic ? [chunk.topic] : []);
    for (const raw of labels) {
      const topic = String(raw || "").trim().slice(0, 80);
      if (!topic) continue;
      if (!topics.has(topic) && topics.size >= Math.min(64, Math.max(1, maxTopics))) continue;
      const list = topics.get(topic) || [];
      if (list.length < Math.min(64, Math.max(1, maxPerTopic)) && chunk?.id && !list.includes(chunk.id)) list.push(String(chunk.id));
      topics.set(topic, list);
    }
  }
  return Object.freeze(Array.from(topics, ([topic, chunkIds]) => Object.freeze({ topic, chunkIds })));
}
