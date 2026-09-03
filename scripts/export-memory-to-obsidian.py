#!/usr/bin/env python3
import argparse, json, re, sqlite3
from datetime import datetime, timezone
from pathlib import Path

def slug(text):
    text = re.sub(r'[\\/:*?"<>|#\[\]]+', ' ', text).strip()
    return re.sub(r'\s+', ' ', text)[:100] or 'Untitled'

def iso(ts):
    if not ts: return ''
    return datetime.fromtimestamp(int(ts), timezone.utc).astimezone().isoformat(timespec='seconds')

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(f'file:{args.db}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    users = {r['id']: r for r in db.execute('select * from memory_users')}
    cards = {}
    for uid, u in users.items(): cards.setdefault(u['card_id'], []).append(uid)
    names = {}
    nodes = {}
    def add_node(kind, ident, user_id, title, body, meta):
        key = (kind, ident); filename = f'{kind.title()} - {slug(title)} - {ident[:8]}.md'
        names[key] = filename[:-3]; nodes[key] = filename
        lines = ['---']
        for k,v in meta.items():
            if v is None or v == '': continue
            if isinstance(v, bool): v = 'true' if v else 'false'
            if isinstance(v, list):
                lines.append(f'{k}:')
                lines.extend(f'  - {json.dumps(x, ensure_ascii=False)}' for x in v)
            else:
                lines.append(f'{k}: {json.dumps(v, ensure_ascii=False) if isinstance(v, str) and (":" in v or "#" in v) else v}')
        lines += ['---', '', f'# {title}', '', body.strip(), '', '## Relations', '']
        (out / filename).write_text('\n'.join(lines), encoding='utf-8')
    for r in db.execute('select * from memory_episodes order by occurred_at, id'):
        u = users[r['user_id']]; title = r['summary'][:70]
        topics = json.loads(r['topics_json'] or '[]'); entities = json.loads(r['entities_json'] or '[]')
        body = r['summary'] + (f"\n\n情绪：{r['emotion']}" if r['emotion'] else '')
        add_node('episode', r['id'], r['user_id'], title, body, {'memory_id':r['id'],'kind':'episode','tags':['memory/episode'],'card_id':u['card_id'],'user_id':r['user_id'],'nickname':u['display_name'],'pinned':bool(r['pinned']),'importance':r['importance'],'occurred_at':iso(r['occurred_at']),'updated_at':iso(r['updated_at']),'managed_by':'kxyy-memory'})
    for r in db.execute('select * from memory_facts order by updated_at, id'):
        u=users[r['user_id']]; add_node('fact', r['id'], r['user_id'], r['text'][:70], r['text'], {'memory_id':r['id'],'kind':'fact','tags':['memory/fact'],'card_id':u['card_id'],'user_id':r['user_id'],'nickname':u['display_name'],'status':r['status'],'pinned':bool(r['pinned']),'confidence':r['confidence'],'importance':r['importance'],'updated_at':iso(r['updated_at']),'managed_by':'kxyy-memory'})
    for r in db.execute('select * from memory_commitments order by updated_at, id'):
        u=users[r['user_id']]; add_node('commitment', r['id'], r['user_id'], r['text'][:70], r['text'], {'memory_id':r['id'],'kind':'commitment','tags':['memory/commitment'],'card_id':u['card_id'],'user_id':r['user_id'],'nickname':u['display_name'],'status':r['status'],'pinned':bool(r['pinned']),'importance':r['importance'],'due_at':iso(r['due_at']),'updated_at':iso(r['updated_at']),'managed_by':'kxyy-memory'})
    for r in db.execute('select * from memory_topics order by name, id'):
        u=users[r['user_id']]; add_node('topic', r['id'], r['user_id'], r['name'], f'主题：{r["name"]}', {'memory_id':r['id'],'kind':'topic','tags':['memory/topic'],'card_id':u['card_id'],'user_id':r['user_id'],'managed_by':'kxyy-memory'})
    for r in db.execute('select * from memory_entities order by canonical_name, id'):
        u=users[r['user_id']]; add_node('entity', r['id'], r['user_id'], r['canonical_name'], f'实体类型：{r["entity_type"]}', {'memory_id':r['id'],'kind':'entity','tags':['memory/entity'],'card_id':u['card_id'],'user_id':r['user_id'],'entity_type':r['entity_type'],'managed_by':'kxyy-memory'})
    edges = list(db.execute('select * from memory_edges order by created_at, id'))
    for e in edges:
        src = names.get((e['from_kind'], e['from_id'])); dst = names.get((e['to_kind'], e['to_id']))
        if not src or not dst or e['user_id'] not in users: continue
        p = out / nodes[(e['from_kind'], e['from_id'])]
        with p.open('a', encoding='utf-8') as f:
            f.write(f'- `{e["relation"]}` → [[{dst}]]' + (' *(derived)*' if e['derived'] else '') + f'  \n  confidence: {e["confidence"]:.2f}\n')
    index = ['# Memory Index','', '> Generated from Memory v3. Edit copies for review; changes are not synced back automatically.','']
    for card, uids in cards.items():
        index += [f'## Card `{card}`','']
        for uid in uids:
            u=users[uid]; index += [f'### {u["display_name"]} (`{uid[:8]}`)','']
            for kind,label in [('fact','Facts'),('episode','Episodes'),('commitment','Commitments'),('topic','Topics'),('entity','Entities')]:
                table = {'fact':'memory_facts','episode':'memory_episodes','commitment':'memory_commitments','topic':'memory_topics','entity':'memory_entities'}[kind]
                count = sum(1 for r in db.execute(f'select id from {table} where user_id=?',(uid,)) if (kind,r['id']) in names)
                if count: index += [f'#### {label}','',f'{count} notes tagged `#memory/{kind}`. Filter by this tag in Graph View.','']
    (out/'Memory Index.md').write_text('\n'.join(index), encoding='utf-8')
    (out/'README.md').write_text('# KXYY Memory Export\n\nThis vault is a read/edit preview of the current Memory v3 database. The index is intentionally not wikilinked, so it does not become a graph hub. Notes use tags such as `#memory/fact` for filtering and colors. Edits are not imported automatically.\n', encoding='utf-8')
    graph = {'colorGroups': [
        {'query':'tag:#memory/fact','color':{'a':1,'rgb':16753920}},
        {'query':'tag:#memory/episode','color':{'a':1,'rgb':45055}},
        {'query':'tag:#memory/commitment','color':{'a':1,'rgb':10944511}},
        {'query':'tag:#memory/topic','color':{'a':1,'rgb':4286945}},
        {'query':'tag:#memory/entity','color':{'a':1,'rgb':14423100}},
    ]}
    (out/'.obsidian').mkdir(exist_ok=True)
    (out/'.obsidian/graph.json').write_text(json.dumps(graph, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'out':str(out),'users':len(users),'edges':len(edges),'notes':len(nodes)}, ensure_ascii=False))

if __name__ == '__main__': main()
