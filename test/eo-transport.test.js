/**
 * EO 双通道 + pagelist 兜底回归测试。
 *
 * 场景：EO 中转（默认 BILIBILI_API_ORIGIN）与官方直连出口的 view 均被 412 风控时，
 * resolveVideo 必须通过 pagelist 拿到 cid / 标题并继续完成取流，而不是整体报风控。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { resolveVideo, AntiCrawlError , resetTransportHealth } from '../index.js';
import { installFetchMock, makeResponse, htmlAntiCrawlResponse } from './setup.js';

afterEach(() => resetTransportHealth());

const BVID = 'BV1Q541167Qg';

function jsonResponse(value, status = 200) {
    return makeResponse(value, { status });
}

describe('EO transport matrix and pagelist fallback', () => {
    it('falls back to pagelist cid and still serves media when view is blocked on every transport', async () => {
        const urls = [];
        installFetchMock({
            'finger/spi': () => jsonResponse({ code: 0, data: { b_3: 'B3', b_4: 'B4' } }),
            'GenWebTicket': () => jsonResponse({ code: 0, data: { ticket: 'TICKET' } }),
            'web-interface/view': (url) => { urls.push(url); return htmlAntiCrawlResponse(412); },
            'player/pagelist': (url) => {
                urls.push(url);
                return jsonResponse({ code: 0, data: [{ cid: 777, part: 'Pagelist title' }] });
            },
            'web-interface/nav': () => htmlAntiCrawlResponse(412),
            'player/playurl': () => jsonResponse({ code: 0, data: { quality: 64, durl: [{ url: 'https://upos-sz-mirrorcosov.bilivideo.com/pagelist.mp4' }] } }),
        });

        const result = await resolveVideo(BVID, 116, 'https://bili.test');
        expect(result.title).toBe('Pagelist title');
        expect(result.author).toBe('');
        expect(result.quality).toBe(64);
        expect(result.playableUrl).toContain('pagelist.mp4');
        expect(urls.some((url) => url.includes('player/pagelist'))).toBe(true);
    });

    it('reports anti-crawl when view and pagelist are both blocked on every transport', async () => {
        installFetchMock({
            'finger/spi': () => jsonResponse({ code: 0, data: {} }),
            'GenWebTicket': () => jsonResponse({ code: 0, data: {} }),
            'web-interface/view': () => htmlAntiCrawlResponse(412),
            'player/pagelist': () => htmlAntiCrawlResponse(412),
        });
        await expect(resolveVideo(BVID, 116, 'https://bili.test')).rejects.toBeInstanceOf(AntiCrawlError);
    });

    it('serves the healthy EO response on the first candidate without extra transports', async () => {
        const fn = installFetchMock({
            'finger/spi': () => jsonResponse({ code: 0, data: { b_3: 'B3' } }),
            'GenWebTicket': () => jsonResponse({ code: 0, data: {} }),
            'web-interface/view': () => jsonResponse({ code: 0, data: { cid: 123, title: 'EO direct', pic: 'p', owner: { name: 'UP主' } } }),
            'web-interface/nav': () => jsonResponse({ code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/a.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/b.png' } } }),
            'player/playurl': () => jsonResponse({ code: 0, data: { quality: 64, durl: [{ url: 'https://upos-sz-mirrorcosov.bilivideo.com/eo.mp4' }] } }),
        });
        const result = await resolveVideo(BVID, 116, 'https://bili.test');
        expect(result.title).toBe('EO direct');
        expect(result.author).toBe('UP主');
        const viewCalls = fn.mock.calls.filter(([input]) => String(input).includes('web-interface/view'));
        expect(viewCalls).toHaveLength(1);
        expect(String(viewCalls[0][0]).startsWith('https://bapi.yamadaryo.me/')).toBe(true);
    });
});
