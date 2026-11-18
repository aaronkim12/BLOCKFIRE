import { encodeShare, decodeShare, type CustomMapData } from './custom';

/**
 * 맵 게시판 (Firebase Firestore, 무료 Spark 요금제).
 * SDK 없이 REST로 읽고 쓴다. 보안 규칙(firestore.rules): 누구나 읽기·새 글 쓰기, 수정·삭제는 불가, 크기 제한.
 * 게시판의 맵도 게임에 쓰기 전에는 항상 공정성 검사를 다시 한다.
 */
const PROJECT = 'blockfire-game';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

export interface GalleryItem {
  docId: string;
  name: string;
  author: string;
  code: string;
  cols: number;
  rows: number;
  createdAt: string;
}

type Fields = Record<string, { stringValue?: string; integerValue?: string; timestampValue?: string }>;

export async function listGallery(): Promise<GalleryItem[]> {
  const r = await fetch(`${BASE}/maps?pageSize=60&orderBy=createdAt%20desc`);
  if (!r.ok) throw new Error(r.status === 403 || r.status === 404 ? '맵 게시판이 아직 준비되지 않았습니다 (공유 코드는 사용 가능)' : `게시판을 불러오지 못했습니다 (${r.status})`);
  const j = (await r.json()) as { documents?: { name: string; fields: Fields }[] };
  return (j.documents ?? []).map((d) => ({
    docId: d.name.split('/').pop() ?? '',
    name: d.fields.name?.stringValue ?? 'CUSTOM',
    author: d.fields.author?.stringValue ?? '',
    code: d.fields.code?.stringValue ?? '',
    cols: Number(d.fields.cols?.integerValue ?? 0),
    rows: Number(d.fields.rows?.integerValue ?? 0),
    createdAt: d.fields.createdAt?.timestampValue ?? '',
  }));
}

export async function publishMap(m: CustomMapData): Promise<void> {
  const body = {
    fields: {
      name: { stringValue: m.name.slice(0, 20) },
      author: { stringValue: (m.author || '익명').slice(0, 16) },
      code: { stringValue: encodeShare(m) },
      cols: { integerValue: String(m.layout[0].length) },
      rows: { integerValue: String(m.layout.length) },
      createdAt: { timestampValue: new Date().toISOString() },
    },
  };
  const r = await fetch(`${BASE}/maps`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(r.status === 403 || r.status === 404 ? '맵 게시판이 아직 준비되지 않았습니다 — 공유 코드를 복사해 직접 전달할 수 있습니다' : `게시하지 못했습니다 (${r.status})`);
}

/** 게시판 글 → 사용자 맵 (id는 게시글 기준으로 고정) */
export function fromGallery(g: GalleryItem): CustomMapData | null {
  const m = decodeShare(g.code, `u:g${g.docId.slice(0, 12)}`);
  if (m) m.author = g.author;
  return m;
}
