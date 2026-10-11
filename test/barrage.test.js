/**
 * 弹幕接口回归测试：resources=bilibarrage2 契约
 * （protobuf 解码、mode 映射、分页 cid、/player 路由）
 */

import { describe, it, expect, afterEach } from 'vitest';
import worker, { parseDanmakuElems, resolveBarrage , resetTransportHealth } from '../index.js';
import { installFetchMock, makeResponse } from './setup.js';

afterEach(() => resetTransportHealth());

// --- 极简 protobuf 编码（测试专用） ---
function varint(n) {
    const out = [];
    let v = n;
    do { let b = v & 0x7f; v = Math.floor(v / 128); if (v > 0) b |= 0x80; out.push(b); } while (v > 0);
    return out;
}
function tag(field, wt) { return varint((field << 3) | wt); }
function lenDelim(field, bytes) { return [...tag(field, 2), ...varint(bytes.length), ...bytes]; }
function varintField(field, value) { return [...tag(field, 0), ...varint(value)]; }
function strBytes(s) { return [...new TextEncoder().encode(s)]; }
function danmakuElem({ content, progress, mode }) {
    return [...varintField(2, progress), ...varintField(3, mode), ...lenDelim(7, strBytes(content))];
}
function segReply(elems) {
    const out = [];
    for (const e of elems) out.push(...lenDelim(1, e));
    return new Uint8Array(out);
}


function binaryResponse(bytes) {
    return new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
}

const HOST = 'https://bili.test';

describe('parseDanmakuElems', () => {
    it('decodes progress(mode2=ms), mode(field3) and content(field7) from a real-shaped segment', () => {
        const buf = segReply([
            danmakuElem({ content: '80年代迪厅必放金曲', progress: 95453, mode: 1 }),
            danmakuElem({ content: '底部', progress: 120000, mode: 4 }),
            danmakuElem({ content: '顶部', progress: 30000, mode: 5 }),
            danmakuElem({ content: '特殊', progress: 1000, mode: 7 }),
        ]);
        const elems = parseDanmakuElems(buf);
        expect(elems).toEqual([
            { text: '80年代迪厅必放金曲', time: 95.453, mode: 1 },
            { text: '底部', time: 120, mode: 4 },
            { text: '顶部', time: 30, mode: 5 },
            { text: '特殊', time: 1, mode: 7 },
        ]);
    });
});

describe('resolveBarrage', () => {
    it('fetches segments, maps modes into the three arrays and sorts by time', async () => {
        let segCalls = 0;
        installFetchMock({
            'finger/spi': () => makeResponse({ data: { b_3: 'B3', b_4: 'B4' } }),
            'GenWebTicket': () => makeResponse({ data: { ticket: 'TICKET' } }),
            'player/pagelist': () => makeResponse({ code: 0, data: [{ cid: 137649199, page: 1, part: 'p1', duration: 720 }] }),
            'seg.so': (url) => {
                segCalls += 1;
                if (url.includes('segment_index=1')) {
                    return binaryResponse(segReply([
                        danmakuElem({ content: 'later scroll', progress: 400000, mode: 1 }),
                        danmakuElem({ content: 'top &amp; hi', progress: 30000, mode: 5 }),
                    ]));
                }
                return binaryResponse(segReply([
                    danmakuElem({ content: 'bottom one', progress: 360000, mode: 4 }),
                    danmakuElem({ content: 'early scroll', progress: 5000, mode: 6 }),
                ]));
            },
        });

        const bar = await resolveBarrage('BV1Q541167Qg', 1);
        expect(segCalls).toBe(2);
        expect(bar.RollBarrage).toEqual([
            { text: 'early scroll', time: 5 },
            { text: 'later scroll', time: 400 },
        ]);
        expect(bar.BottomBarrage).toEqual([{ text: 'bottom one', time: 360 }]);
        expect(bar.TopBarrage).toEqual([{ text: 'top & hi', time: 30 }]);
    });

    it('caps the segment count for very long videos', async () => {
        const seen = new Set();
        installFetchMock({
            'finger/spi': () => makeResponse({ data: {} }),
            'GenWebTicket': () => makeResponse({ data: {} }),
            'player/pagelist': () => makeResponse({ code: 0, data: [{ cid: 1, page: 1, part: 'p', duration: 100000 }] }),
            'seg.so': (url) => {
                seen.add(url.match(/segment_index=(\d+)/)[1]);
                return binaryResponse([0]);
            },
        });
        await resolveBarrage('BV1Q541167Qg', 1);
        expect(seen.size).toBe(40);
        expect(Math.max(...[...seen].map(Number))).toBe(40);
    });
});

describe('/player route (resources=bilibarrage2)', () => {
    it('returns { data: { TopBarrage, BottomBarrage, RollBarrage } } with CORS and cache headers', async () => {
        installFetchMock({
            'finger/spi': () => makeResponse({ data: {} }),
            'GenWebTicket': () => makeResponse({ data: {} }),
            'player/pagelist': () => makeResponse({ code: 0, data: [{ cid: 7, page: 1, part: 'p', duration: 300 }] }),
            'seg.so': () => binaryResponse(segReply([danmakuElem({ content: 'hello', progress: 12000, mode: 1 })])),
        });
        const res = await worker.fetch(new Request(`${HOST}/player/?resources=bilibarrage2&id=BV1Q541167Qg`), {}, {});
        expect(res.status).toBe(200);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(res.headers.get('Cache-Control')).toBe('public, max-age=600');
        const body = await res.json();
        expect(body).toEqual({ data: { TopBarrage: [], BottomBarrage: [], RollBarrage: [{ text: 'hello', time: 12 }] } });
    });

    it('redirects /player/?url=<bilibili link> to the playable proxy stream', async () => {
        installFetchMock({
            'finger/spi': () => makeResponse({ data: {} }),
            'GenWebTicket': () => makeResponse({ data: {} }),
            'web-interface/view': () => makeResponse({ code: 0, data: { cid: 123, title: 'TV video', pic: 'p', owner: { name: 'UP' } } }),
            'web-interface/nav': () => makeResponse({ data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/a.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/b.png' } } }),
            'player/playurl': () => makeResponse({ code: 0, data: { quality: 64, durl: [{ url: 'https://upos-sz-mirrorcosov.bilivideo.com/tv.mp4' }] } }),
        });
        const res = await worker.fetch(new Request(`${HOST}/player/?url=https://www.bilibili.com/video/BV1Q541167Qg`), {}, {});
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toContain('bili.test/proxy?url=');
        expect(res.headers.get('Location')).toContain('tv.mp4');
    });

    it('accepts Udon-glued request shapes (no proper &id separator)', async () => {
        installFetchMock({
            'finger/spi': () => makeResponse({ data: {} }),
            'GenWebTicket': () => makeResponse({ data: {} }),
            'player/pagelist': () => makeResponse({ code: 0, data: [{ cid: 7, page: 1, part: 'p', duration: 300 }] }),
            'seg.so': () => binaryResponse(segReply([danmakuElem({ content: 'glued', progress: 1000, mode: 1 })])),
        });
        const shapes = [
            `${HOST}/player/?resources=bilibarrage2?id=BV1Q541167Qg`,
            `${HOST}/player/?resources=bilibarrage2BV1Q541167Qg`,
            `${HOST}/player/?resources=bilibarrage2BV1Q541167Qg?p=2`,
            `${HOST}/player/?resources=bilibarrage2&id=BV1Q541167Qg&p=2`,
        ];
        for (const shape of shapes) {
            const res = await worker.fetch(new Request(shape), {}, {});
            const body = await res.json();
            expect(body.data ? body.data.RollBarrage : body).toEqual([{ text: 'glued', time: 1 }]);
        }
    });

    it('answers invalid BV ids and unknown resources with player-friendly errors', async () => {
        installFetchMock({});
        const bad = await (await worker.fetch(new Request(`${HOST}/player/?resources=bilibarrage2&id=nope`), {}, {})).json();
        expect(bad).toEqual({ status: 'error', message: '无效的 BV 号' });
        const unk = await (await worker.fetch(new Request(`${HOST}/player/?resources=searchimage&id=BV1Q541167Qg`), {}, {})).json();
        expect(unk).toEqual({ status: 'error', message: '不支持的 resources 类型' });
    });

    it('supports the p (page) parameter for multi-part videos', async () => {
        let requestedCid = null;
        installFetchMock({
            'finger/spi': () => makeResponse({ data: {} }),
            'GenWebTicket': () => makeResponse({ data: {} }),
            'player/pagelist': () => makeResponse({ code: 0, data: [
                { cid: 111, page: 1, part: 'p1', duration: 100 },
                { cid: 222, page: 2, part: 'p2', duration: 100 },
            ] }),
            'seg.so': (url) => {
                requestedCid = url.match(/oid=(\d+)/)[1];
                return binaryResponse(segReply([danmakuElem({ content: 'x', progress: 1000, mode: 1 })]));
            },
        });
        const res = await worker.fetch(new Request(`${HOST}/player/?resources=bilibarrage2&id=BV1Q541167Qg&p=2`), {}, {});
        const body = await res.json();
        expect(requestedCid).toBe('222');
        expect(body.data.RollBarrage).toEqual([{ text: 'x', time: 1 }]);
    });
});
