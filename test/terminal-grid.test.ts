// Pure protocol rules and real Chromium against generated frames. No live Herdr/Pocket access.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { terminalFixture } from "./terminal-grid-fixture.ts";

const MODULE: string = "../web/terminal-grid.js";
const {
    DEFAULT_THEME,
    wireColor,
    cellColors,
    symbolWidth,
    validFrame,
    safeHyperlink,
    keyEvent,
    targetAt,
    mouseEvent,
    selectionText,
    imageBytes,
    clipboardPNG,
    MAX_CLIPBOARD_IMAGE_BYTES,
    MAX_SELECTION_BYTES,
} = await import(MODULE);
const cell = (symbol = " ", modifier = 0) => ({
    symbol,
    modifier,
    fg: 0,
    bg: 0,
    skip: false,
    hyperlink: null,
});
const frame = (symbols: string[], width = symbols.length) => ({
    width,
    height: symbols.length / width,
    cells: symbols.map((s) => cell(s)),
    cursor: null,
    hyperlinks: [],
    graphics: [],
});

test("Herdr named/indexed/RGB/default colors and modifier order", () => {
    assert.equal(wireColor(0, 0x123456), 0x123456);
    assert.equal(wireColor(1, 0), 0x000000);
    assert.equal(wireColor(16, 0), 0xffffff);
    assert.equal(wireColor(0x010000c4, 0), 0xff0000);
    assert.equal(wireColor(0x010000ff, 0), 0xeeeeee);
    assert.equal(wireColor(0x02123456, 0), 0x123456);
    assert.equal(wireColor(0xff123456, 42), 42);
    assert.deepEqual(cellColors({ ...cell("x", 64), fg: 0x02ff0000, bg: 0x020000ff }), {
        fg: 0x0000ff,
        bg: 0xff0000,
    });
    assert.deepEqual(cellColors({ ...cell("x", 64 | 2 | 128), fg: 0x02ff0000, bg: 0x020000ff }), {
        fg: 0xff0000,
        bg: 0xff0000,
    });
    assert.equal(cellColors(cell("x", 1), { ...DEFAULT_THEME, bold: 0xabcdef }).fg, 0xabcdef);
});

test("Rust externally tagged key enums; browser/IME/dead/AltGraph keys left alone", () => {
    assert.deepEqual(keyEvent({ key: "ArrowUp" }), {
        Key: {
            code: "Up",
            modifiers: 0,
            kind: "Press",
            repeat_count: 1,
            shifted_codepoint: null,
            generated_text: null,
            tracks_release: false,
            physical_key_id: null,
            windows_record: null,
        },
    });
    assert.equal(keyEvent({ key: "Tab", shiftKey: true }).Key.code, "BackTab");
    assert.deepEqual(keyEvent({ key: "F24" }).Key.code, { F: 24 });

    for (const [key, code] of Object.entries({
        Enter: "Enter",
        Backspace: "Backspace",
        Escape: "Esc",
        Tab: "Tab",
        Delete: "Delete",
        Insert: "Insert",
        Home: "Home",
        End: "End",
        PageUp: "PageUp",
        PageDown: "PageDown",
        ArrowLeft: "Left",
        ArrowRight: "Right",
        ArrowUp: "Up",
        ArrowDown: "Down",
    })) {
        assert.equal(keyEvent({ key }).Key.code, code);
    }

    for (let n = 1; n <= 24; n++) {
        assert.deepEqual(keyEvent({ key: `F${n}` }).Key.code, { F: n });
    }

    assert.deepEqual(keyEvent({ key: "Ω", altKey: true }, { altKeys: true }).Key.code, {
        Char: "Ω",
    });
    assert.deepEqual(keyEvent({ key: "c", ctrlKey: true }).Key.code, { Char: "c" });
    assert.equal(
        keyEvent({ key: "x", ctrlKey: true, repeat: true }, { reportAllKeys: true }).Key.kind,
        "Repeat",
    );
    assert.equal(
        keyEvent({ key: "x", ctrlKey: true }, { reportAllKeys: true }).Key.tracks_release,
        true,
    );

    for (const event of [
        { key: "a" },
        { key: "π", altKey: true },
        { key: "Dead" },
        { key: "F25" },
        { key: "Enter", isComposing: true },
        { key: "Enter", metaKey: true },
        { key: "@", ctrlKey: true, altKey: true, getModifierState: () => true },
    ]) {
        assert.equal(keyEvent(event), null);
    }
});

test("wide cells, ordinary blank continuations, hidden text and bounded pane selection", () => {
    assert.equal(symbolWidth("漢"), 2);
    assert.equal(symbolWidth("e\u0301"), 1);
    assert.equal(symbolWidth("👩‍💻"), 2);
    assert.equal(symbolWidth("🇦🇱"), 2);
    const f = frame(["漢", " ", "é", "x", "right", "a", "b", "c", "d", "right"], 5);

    assert.ok(f.cells[3]);
    f.cells[3].modifier = 128;
    const region = { x: 0, y: 0, width: 4, height: 2 };

    assert.equal(selectionText(f, region, { x: 1, y: 0 }, { x: 20, y: 20 }), "漢é\nabcd");
    assert.equal(selectionText(f, region, { x: 20, y: 20 }, { x: 1, y: 0 }), "漢é\nabcd");
    assert.ok(Buffer.byteLength(selectionText(f, region, { x: 0, y: 0 }, { x: 3, y: 1 }, 4)) <= 4);
    const huge = frame(Array.from({ length: 4096 }, () => "x" + "\u0301".repeat(511)));

    assert.ok(
        Buffer.byteLength(
            selectionText(
                huge,
                { x: 0, y: 0, width: 4096, height: 1 },
                { x: 0, y: 0 },
                { x: 4095, y: 0 },
            ),
        ) <= MAX_SELECTION_BYTES,
    );
    assert.equal(validFrame({ ...f, cells: [] }), false);
    assert.equal(validFrame({ ...f, width: 1_000_000 }), false);
    assert.equal(validFrame({ ...f, cells: [{ ...cell("x"), symbol: "x".repeat(1025) }] }), false);
});

test("links accept explicit HTTP(S) destinations only; no relative, credentialed or executable links", () => {
    assert.equal(safeHyperlink("https://example.com/path?q=x"), "https://example.com/path?q=x");

    for (const url of [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "data:text/html,hi",
        "//example.com",
        "/api",
        "https://u:p@example.com",
        "https://a.com/\n",
    ]) {
        assert.equal(safeHyperlink(url), null);
    }
});

test("pane-local pixel geometry, popup isolation and semantic wheel shape", () => {
    const surface = {
        frame: frame(Array(100).fill(" "), 10),
        panes: [
            {
                pane_id: "pane",
                inner_rect: { x: 2, y: 3, width: 4, height: 5 },
                sgr_pixel_mouse: true,
                pixel_width: 40,
                pixel_height: 100,
            },
        ],
        popup: null,
    };
    const target = targetAt(surface, 3.5, 4.5);

    assert.equal(target.id, "pane");
    assert.equal(targetAt(surface, 1, 1), null);
    assert.deepEqual(mouseEvent(target, 3.5, 4.5, "ScrollUp", { shiftKey: true }, {}, 2), {
        Mouse: {
            kind: "ScrollUp",
            position: { Pixels: { x: 15, y: 30, column: 1, row: 1 } },
            geometry: { cols: 4, rows: 5, width_px: 40, height_px: 100 },
            modifiers: 1,
            lines: 2,
        },
    });
    const popup = { terminal_id: "popup", frame: frame(Array(4).fill(" "), 2) };

    assert.equal(targetAt({ ...surface, popup }, 1, 1), null);
    assert.equal(targetAt({ ...surface, popup }, 4, 4).id, "popup");
});

test("native image data accepts RGB/RGBA and rejects excessive, malformed and forged PNG dimensions", () => {
    const image = {
        key: { image_width: 1, image_height: 1, data_len: 3, format: "Rgb" },
        encoding: "base64",
        data: "AQID",
    };

    assert.deepEqual([...imageBytes(image)], [1, 2, 3]);
    assert.throws(() => imageBytes({ ...image, key: { ...image.key, image_width: 5000 } }));
    assert.throws(() => imageBytes({ ...image, key: { ...image.key, format: "Png" } }));
    assert.throws(() => imageBytes({ ...image, data: "!!!!" }));
    assert.throws(() => imageBytes({ ...image, data: "https://example.com/pixel" }));
});

test("explicit clipboard PNG validation bounds bytes and dimensions before sending", async () => {
    const data =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9kAAAAASUVORK5CYII=";
    const bytes = Buffer.from(data, "base64");

    assert.deepEqual(await clipboardPNG(new Blob([bytes], { type: "image/png" })), {
        encoding: "base64",
        format: "png",
        data,
    });
    await assert.rejects(clipboardPNG(new Blob([bytes], { type: "image/jpeg" })), /Only PNG/);
    await assert.rejects(
        clipboardPNG({
            type: "image/png",
            size: MAX_CLIPBOARD_IMAGE_BYTES + 1,
            arrayBuffer: () => {
                throw new Error("must not read oversized file");
            },
        }),
        /8 MiB/,
    );
    const oversized = Buffer.from(bytes);

    oversized.writeUInt32BE(4097, 16);
    await assert.rejects(clipboardPNG(new Blob([oversized], { type: "image/png" })), /4096/);
    await assert.rejects(clipboardPNG(new Blob(["not a PNG"], { type: "image/png" })), /PNG/);
});

async function value<T>(page: BrowserPage, expression: string): Promise<T> {
    return JSON.parse(await page.evaluate(`return JSON.stringify(${expression})`)) as T;
}

async function settle(page: BrowserPage) {
    await page.evaluate("await new Promise(resolve => setTimeout(resolve, 100))");
}

test(
    "pane painting clips overlong symbols, graphics and cursor to visible pane geometry",
    {
        skip: findBrowser() ? false : "No Chromium installed",
        timeout: 60_000,
    },
    async () => {
        const fixture = await terminalFixture();
        const dir = mkdtempSync(join(tmpdir(), "terminal-grid-clipping-"));
        const browsers = new Browsers({ dataDir: dir });

        try {
            const page = await browsers.open(1);

            await page.setViewport(VIEWPORTS.desktop);
            await page.navigate(fixture.url);
            await settle(page);
            await page.evaluate(`const blank={symbol:' ',fg:0,bg:0,modifier:0,skip:false,hyperlink:null};
            const cells=Array.from({length:32*4},()=>({...blank}));
            cells[0]={...blank,symbol:'LEFT-PANE-TEXT-MUST-NOT-CROSS',fg:0x02ff0000,modifier:1|4|8|256};
            for(let y=0;y<4;y++){cells[y*32+4]={...blank,symbol:'│',fg:0x020000ff};cells[y*32+5]={...blank,symbol:'█',fg:0x0200ff00};}
            const rect=(x,width)=>({x,y:0,width,height:4});
            const panes=[{...fixture.props.surface.panes[0],rect:rect(0,5),inner_rect:rect(0,4),focused:true},
                {...fixture.props.surface.panes[1],rect:rect(5,8),inner_rect:rect(5,8),focused:false}];
            const frame={width:32,height:4,cells,graphics:[],hyperlinks:[],cursor:{x:6,y:1,visible:true,shape:2}};
            fixture.draw({surface:{...fixture.props.surface,frame,panes,splits:[],graphics:{assets:[],placements:[],retained_assets:[]}}});
            fixture.rightPixels=()=>{const c=document.querySelector('canvas'),s=c.width/320;
                const data=c.getContext('2d').getImageData(50*s,0,80*s,80*s).data;let red=0,green=0;
                for(let i=0;i<data.length;i+=4){if(data[i]>150&&data[i+1]<60&&data[i+2]<60)red++;if(data[i+1]>150&&data[i]<60&&data[i+2]<60)green++;}
                return {red,green};};`);
            await settle(page);
            const glyphs = await value<{ red: number; green: number }>(
                page,
                "fixture.rightPixels()",
            );
            const cursorVisible = await value<boolean>(
                page,
                "!!document.querySelector('.terminal-grid-cursor')",
            );
            const neighbor = await value<number[]>(
                page,
                `(() => {const c=document.querySelector('canvas'),s=c.width/320;return [...c.getContext('2d').getImageData(55*s,10*s,1,1).data]})()`,
            );

            await page.evaluate(`const key={source:{Terminal:{target:{Pane:{pane_id:'pane-left'}},image_id:1}},image_width:1,image_height:1,format:'Rgb',data_len:3,data_fingerprint:'18446744073709551615'};
            const placement={asset:key,logical_placement_id:1,x:2,y:2,cols:20,rows:2,source_x:0,source_y:0,source_width:0,source_height:0,x_offset:0,y_offset:0,z:1,scrollback_offset:0};
            fixture.draw({images:[{key,serial:1,encoding:'base64',data:'/wAA'}],surface:{...fixture.props.surface,graphics:{assets:[],placements:[placement],retained_assets:[]}}});`);
            await settle(page);
            const graphics = await value<{ red: number; green: number }>(
                page,
                "fixture.rightPixels()",
            );

            await shot(page, "pane-clip");
            assert.deepEqual(
                {
                    glyphBleed: glyphs.red > 0,
                    neighborVisible: glyphs.green > 0,
                    graphicsBleed: graphics.red > 0,
                    cursorVisible,
                },
                {
                    glyphBleed: false,
                    neighborVisible: true,
                    graphicsBleed: false,
                    cursorVisible: false,
                },
            );
            assert.deepEqual(
                neighbor,
                [0, 255, 0, 255],
                "the neighbor glyph survives an overlong left-pane symbol on the same row",
            );
            assert.deepEqual(
                page.logs().filter((entry) => entry.level === "error"),
                [],
            );
        } finally {
            await browsers.closeAll({ final: true });
            fixture.server.closeAllConnections();
            await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
            rmSync(dir, { recursive: true, force: true });
        }
    },
);

test(
    "terminal focus regressions: first click, immediate typing and activation border",
    {
        skip: findBrowser() ? false : "No Chromium installed",
        timeout: 60_000,
    },
    async (t) => {
        const fixture = await terminalFixture();
        const dir = mkdtempSync(join(tmpdir(), "terminal-grid-focus-"));
        const browsers = new Browsers({ dataDir: dir });

        try {
            const page = await browsers.open(1);

            await page.setViewport(VIEWPORTS.desktop);
            await page.navigate(fixture.url);
            await settle(page);
            await t.test(
                "first click reaches the TUI and immediate text uses intended pane before acknowledgement",
                async () => {
                    await page.evaluate(
                        `fixture.draw({surface:{...fixture.props.surface,panes:fixture.props.surface.panes.map((p,i)=>({...p,focused:i===1,mouse_reporting:true}))}});`,
                    );
                    await settle(page);
                    await page.evaluate(`fixture.order=[];fixture.inputs=[];fixture.actions=[];
                fixture.point('pointerdown',1,2);fixture.point('pointerup',1,2);
                const input=document.querySelector('.terminal-grid-input');input.value='immediate';input.dispatchEvent(new InputEvent('input',{data:'immediate',bubbles:true}));`);
                    assert.deepEqual(
                        await value(
                            page,
                            `fixture.order.map(x=>x.type==='action'?['focus',x.action.paneId]:[x.events[0].Mouse?.kind||'text',x.id])`,
                        ),
                        [
                            ["focus", "pane-left"],
                            [{ Down: "Left" }, "pane-left"],
                            [{ Up: "Left" }, "pane-left"],
                            ["text", "pane-left"],
                        ],
                    );
                },
            );
            await t.test(
                "textarea focus and viewport keyboard focus have no activation outline",
                async () => {
                    await page.evaluate(`document.querySelector('.terminal-grid-input').focus();`);
                    await settle(page);
                    const textarea = await value<string>(
                        page,
                        "getComputedStyle(document.querySelector('.terminal-grid-viewport')).outlineStyle",
                    );

                    assert.equal(
                        await value(
                            page,
                            "getComputedStyle(document.querySelector('.terminal-grid-input')).outlineStyle",
                        ),
                        "none",
                    );
                    await page.press("Shift+Escape");
                    const viewport = await value<string>(
                        page,
                        "getComputedStyle(document.querySelector('.terminal-grid-viewport')).outlineStyle",
                    );

                    await shot(page, "focus-outline");
                    assert.deepEqual(
                        { textarea, viewport },
                        { textarea: "none", viewport: "none" },
                    );
                },
            );
            await t.test(
                "desktop pointer entry activates typing without an activation click",
                async () => {
                    await page.evaluate(
                        `document.activeElement.blur();fixture.point('pointerenter',1,2,{pointerType:'mouse',buttons:0});`,
                    );
                    assert.equal(
                        await value(page, "document.activeElement.className"),
                        "terminal-grid-input",
                    );
                },
            );
            await t.test(
                "hover and restore guards protect outside editors, modals, drags, IME and mobile keyboards",
                async () => {
                    await page.evaluate(
                        `document.querySelector('#outside').focus();fixture.point('pointerenter',1,2,{pointerType:'mouse'});`,
                    );
                    assert.equal(await value(page, "document.activeElement.id"), "outside");
                    assert.equal(await value(page, "fixture.focusRef.current.focus()"), false);
                    await page.evaluate(
                        `document.activeElement.blur();fixture.point('pointerenter',1,2,{pointerType:'mouse',buttons:1});`,
                    );
                    assert.equal(await value(page, "fixture.focusRef.current.isFocused()"), false);
                    await page.evaluate(
                        `const modal=document.createElement('div');modal.id='focus-modal';modal.role='dialog';modal.setAttribute('aria-modal','true');modal.textContent='Modal';document.body.append(modal);fixture.point('pointerenter',1,2,{pointerType:'mouse'});`,
                    );
                    assert.equal(await value(page, "fixture.focusRef.current.focus()"), false);
                    await page.evaluate(
                        `document.querySelector('#focus-modal').remove();document.body.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));fixture.point('pointerenter',1,2,{pointerType:'mouse'});`,
                    );
                    assert.equal(await value(page, "fixture.focusRef.current.isFocused()"), false);
                    await page.evaluate(
                        `document.body.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));document.body.dispatchEvent(new DragEvent('dragstart',{bubbles:true}));fixture.point('pointerenter',1,2,{pointerType:'mouse'});`,
                    );
                    assert.equal(await value(page, "fixture.focusRef.current.focus()"), false);
                    await page.evaluate(
                        `document.body.dispatchEvent(new DragEvent('dragend',{bubbles:true}));`,
                    );
                    assert.equal(await value(page, "fixture.focusRef.current.focus()"), true);
                    await page.setViewport(VIEWPORTS.mobile);
                    await settle(page);
                    await page.evaluate(
                        `document.activeElement.blur();fixture.point('pointerenter',1,2,{pointerType:'mouse'});fixture.point('pointerenter',1,2,{pointerType:'touch'});`,
                    );
                    assert.equal(await value(page, "fixture.focusRef.current.isFocused()"), false);
                    assert.equal(await value(page, "fixture.focusRef.current.focus()"), false);
                    await page.setViewport(VIEWPORTS.desktop);
                    await settle(page);
                },
            );
            await t.test(
                "local pane intent survives stale metadata, acknowledges new focus, and cancels removal, boot change and rejection",
                async () => {
                    await page.evaluate(`fixture.base=structuredClone(fixture.props.surface);
                fixture.draw({surface:{...fixture.base,panes:fixture.base.panes.map((p,i)=>({...p,focused:i===1,mouse_reporting:true}))}});
                fixture.typeText=(text)=>{const i=document.querySelector('.terminal-grid-input');i.value=text;i.dispatchEvent(new InputEvent('input',{data:text,bubbles:true}))};`);
                    await settle(page);
                    await page.evaluate(`fixture.inputs=[];fixture.cancelTarget=fixture.focusRef.current.setTarget('pane-left');fixture.typeText('intended');
                fixture.draw({surface:{...fixture.props.surface,surface_revision:2}});`);
                    await settle(page);
                    await page.evaluate(`fixture.typeText('stale');`);
                    assert.deepEqual(await value(page, "fixture.inputs.map(i=>i.id)"), [
                        "pane-left",
                        "pane-left",
                    ]);
                    await page.evaluate(
                        `fixture.draw({surface:{...fixture.props.surface,surface_revision:3,panes:fixture.base.panes.map((p,i)=>({...p,focused:i===0,mouse_reporting:true}))}});`,
                    );
                    await settle(page);
                    await page.evaluate(
                        `fixture.draw({surface:{...fixture.props.surface,surface_revision:4,panes:fixture.base.panes.map((p,i)=>({...p,focused:i===1,mouse_reporting:true}))}});`,
                    );
                    await settle(page);
                    await page.evaluate(`fixture.typeText('after-ack');`);
                    assert.equal(
                        await value(page, "fixture.inputs.at(-1).id"),
                        "pane-right",
                        "acknowledged local intent no longer masks native navigation",
                    );
                    await page.evaluate(
                        `fixture.focusRef.current.setTarget('pane-left');fixture.draw({surface:{...fixture.props.surface,panes:fixture.props.surface.panes.filter(p=>p.pane_id!=='pane-left')}});`,
                    );
                    await settle(page);
                    await page.evaluate(`fixture.typeText('removed');`);
                    assert.equal(await value(page, "fixture.inputs.at(-1).id"), "pane-right");
                    await page.evaluate(
                        `fixture.draw({surface:{...fixture.base,panes:fixture.base.panes.map((p,i)=>({...p,focused:i===1,mouse_reporting:true}))}});`,
                    );
                    await settle(page);
                    await page.evaluate(
                        `fixture.focusRef.current.setTarget('pane-left');fixture.draw({surface:{...fixture.props.surface,boot_id:'new-focus-boot'}});`,
                    );
                    await settle(page);
                    await page.evaluate(`fixture.typeText('new-boot');`);
                    assert.equal(await value(page, "fixture.inputs.at(-1).id"), "pane-right");
                    await page.evaluate(
                        `fixture.inputs=[];fixture.focusReply=false;fixture.point('pointerdown',1,2);fixture.point('pointerup',1,2);`,
                    );
                    assert.equal(
                        await value(page, "fixture.inputs.length"),
                        0,
                        "synchronously rejected focus does not send the mouse click",
                    );
                    await page.evaluate(
                        `fixture.typeText('rejected');fixture.focusReply=Promise.resolve(false);fixture.point('pointerdown',1,2);fixture.point('pointerup',1,2);`,
                    );
                    await settle(page);
                    await page.evaluate(
                        `fixture.typeText('async-rejected');fixture.focusReply=undefined;`,
                    );
                    assert.equal(await value(page, "fixture.inputs.at(-1).id"), "pane-right");
                    await page.evaluate(
                        `fixture.cancelOld=fixture.focusRef.current.setTarget('pane-left');fixture.cancelNew=fixture.focusRef.current.setTarget('pane-right');fixture.cancelOld();fixture.typeText('new-intent');fixture.cancelNew();`,
                    );
                    assert.equal(
                        await value(page, "fixture.inputs.at(-1).id"),
                        "pane-right",
                        "an old rejection cannot cancel a newer intent",
                    );
                },
            );
            await t.test(
                "popup owns input and background clicks never reach another PTY",
                async () => {
                    await page.evaluate(
                        `const frame={...fixture.props.surface.frame,width:2,height:2,cells:fixture.props.surface.frame.cells.slice(0,4),cursor:null};fixture.draw({surface:{...fixture.props.surface,popup:{terminal_id:'focus-popup',title:'Popup',frame,mouse_reporting:true,sgr_pixel_mouse:false,pixel_width:20,pixel_height:40}}});`,
                    );
                    await settle(page);
                    await page.evaluate(
                        `fixture.order=[];fixture.inputs=[];fixture.focusRef.current.setTarget('pane-left');fixture.point('pointerdown',1,2);fixture.point('pointerup',1,2);`,
                    );
                    assert.deepEqual(await value(page, "fixture.order"), []);
                    await page.evaluate(
                        `fixture.typeText('popup');fixture.point('pointerdown',31,6);fixture.point('pointerup',31,6);`,
                    );
                    assert.deepEqual(
                        await value(page, "fixture.inputs.map(i=>[i.id,i.popup])"),
                        Array(3).fill(["focus-popup", true]),
                    );
                    await page.evaluate(
                        `fixture.draw({surface:{...fixture.props.surface,popup:null}});`,
                    );
                    await settle(page);
                },
            );
            await t.test(
                "native frame resize keeps the input node, ref and active composition",
                async () => {
                    await page.evaluate(`document.activeElement.blur();fixture.focusRef.current.focus();fixture.savedInput=document.querySelector('.terminal-grid-input');fixture.savedRef=fixture.focusRef.current;
                fixture.inputs=[];fixture.savedInput.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
                const frame=fixture.props.surface.frame;fixture.draw({surface:{...fixture.props.surface,frame:{...frame,height:frame.height+1,cells:[...frame.cells,...frame.cells.slice(0,frame.width)]}}});`);
                    await settle(page);
                    assert.equal(
                        await value(
                            page,
                            "fixture.savedInput===document.querySelector('.terminal-grid-input') && fixture.savedRef===fixture.focusRef.current && fixture.focusRef.current.isFocused()",
                        ),
                        true,
                    );
                    await page.evaluate(
                        `fixture.savedInput.dispatchEvent(new CompositionEvent('compositionend',{data:'保留',bubbles:true}));`,
                    );
                    assert.deepEqual(await value(page, "fixture.inputs.map(i=>i.events[0])"), [
                        { TextCommit: "保留" },
                    ]);
                },
            );
            assert.deepEqual(
                page.logs().filter((entry) => entry.level === "error"),
                [],
            );
        } finally {
            await browsers.closeAll({ final: true });
            fixture.server.closeAllConnections();
            await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
            rmSync(dir, { recursive: true, force: true });
        }
    },
);

async function shortcuts(page: BrowserPage) {
    await page.evaluate(`fixture.shortcutCalls=[];fixture.globalKeys=[];fixture.chords=[];
        fixture.globalKey=(e)=>fixture.globalKeys.push(e.key);document.addEventListener('keydown',fixture.globalKey);
        let prefix=false,timer;
        fixture.draw({reportAllKeys:true,onShortcut:(e,context)=>{
            fixture.shortcutCalls.push({key:e.key,...context});
            if(e.ctrlKey && e.key==='b'){prefix=true;clearTimeout(timer);timer=setTimeout(()=>{prefix=false},40);return true;}
            if(prefix){prefix=false;clearTimeout(timer);fixture.chords.push(e.key);return e.key==='x';}
            return e.metaKey && e.key==='d';
        }});
        fixture.key=(key,extra={})=>{
            const e=new KeyboardEvent('keydown',{key,code:key,bubbles:true,cancelable:true,...extra});
            document.querySelector('.terminal-grid-input').dispatchEvent(e);return e.defaultPrevented;
        };`);
    await settle(page);
    await page.evaluate(`document.querySelector('.terminal-grid-input').focus();
        fixture.consumed=[fixture.key('b',{ctrlKey:true}),fixture.key('x'),fixture.key('d',{metaKey:true})];`);
    await page.evaluate(
        `document.querySelector('.terminal-grid-input').dispatchEvent(new KeyboardEvent('keyup',{key:'x',code:'x',bubbles:true,cancelable:true}));fixture.draw({reportAllKeys:false});`,
    );
    await settle(page);
    assert.deepEqual(await value(page, "fixture.consumed"), [true, true, true]);
    assert.deepEqual(await value(page, "fixture.chords"), ["x"]);
    assert.equal(
        await value(page, "fixture.inputs.length"),
        0,
        "bindings and chord prefixes never reach the PTY",
    );
    assert.deepEqual(await value(page, "fixture.shortcutCalls[0]"), {
        key: "b",
        targetId: "pane-left",
        popup: false,
    });
    assert.deepEqual(
        await value(page, "fixture.globalKeys"),
        [],
        "Pocket bubbling shortcuts do not see terminal keys",
    );
    await page.evaluate(`fixture.key('b',{ctrlKey:true});`);
    await settle(page);
    await page.evaluate(`fixture.key('ArrowLeft');`);
    assert.deepEqual(
        await value(page, "fixture.inputs[0].events[0]"),
        keyEvent({ key: "ArrowLeft" }),
    );
    await page.press("a");
    assert.deepEqual(await value(page, "fixture.inputs[1].events[0]"), { TextCommit: "a" });
    const calls = await value<number>(page, "fixture.shortcutCalls.length");

    await page.evaluate(`fixture.key('Dead');fixture.key('Process',{isComposing:true});`);
    assert.equal(
        await value(page, "fixture.shortcutCalls.length"),
        calls,
        "IME and dead keys bypass shortcut matching",
    );
    await page.evaluate(
        `fixture.inputs=[];fixture.draw({onShortcut:(e)=>{e.preventDefault();return false}});`,
    );
    await settle(page);
    await page.evaluate(`fixture.key('c',{ctrlKey:true});`);
    assert.equal(
        await value(page, "fixture.inputs.length"),
        0,
        "preventDefault also consumes the shortcut",
    );
    await page.evaluate(
        `fixture.draw({onShortcut:undefined});document.querySelector('#outside').focus();`,
    );
    await settle(page);
    await page.press("g");
    assert.deepEqual(
        await value(page, "fixture.globalKeys"),
        ["g"],
        "shortcuts outside the terminal are unchanged",
    );
    await page.evaluate(
        `document.removeEventListener('keydown',fixture.globalKey);fixture.inputs=[];`,
    );
}

async function shot(page: BrowserPage, name: string) {
    const dir = process.env.TERMINAL_GRID_SCREENSHOT_DIR;

    if (dir) {
        mkdirSync(dir, { recursive: true });
        const image = await page.screenshot();

        writeFileSync(join(dir, `${name}.jpg`), Buffer.from(image.data, "base64"));
    }
}

test(
    "Chromium desktop/mobile: canvas, IME, shortcuts, paste, selection, mouse, popups, disabled mode and cleanup",
    {
        skip: findBrowser() ? false : "No Chromium installed",
        timeout: 60_000,
    },
    async () => {
        const fixture = await terminalFixture();
        const dir = mkdtempSync(join(tmpdir(), "terminal-grid-browser-"));
        const browsers = new Browsers({ dataDir: dir });

        try {
            const page = await browsers.open(1);

            await page.setViewport(VIEWPORTS.desktop);
            await page.navigate(fixture.url);
            await settle(page);
            assert.equal(
                await value(page, "document.activeElement.id"),
                "outside",
                "render does not steal focus",
            );
            assert.equal(await value(page, "fixture.inputs.length"), 0);
            assert.ok((await value<number>(page, "fixture.sizes.length")) > 0);
            assert.equal(await value(page, "fixture.actions.length"), 0);
            assert.deepEqual(
                await value(
                    page,
                    `(() => { const c=document.querySelector('canvas'); return [...c.getContext('2d').getImageData(c.width/640*5,c.height/280*245,1,1).data] })()`,
                ),
                [0x12, 0x34, 0x56, 255],
            );
            assert.equal(
                await value(
                    page,
                    "getComputedStyle(document.querySelector('.terminal-grid-keybar')).display",
                ),
                "none",
                "desktop helper keys are hidden by CSS",
            );
            assert.equal(
                await value(
                    page,
                    "getComputedStyle(document.querySelector('.terminal-grid-tools')).display",
                ),
                "none",
                "desktop has no bottom helper bar",
            );
            await shot(page, "desktop");
            await shortcuts(page);
            await page.evaluate(`document.querySelector('.terminal-grid-input').focus();
            const input=document.querySelector('.terminal-grid-input');
            input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}));
            input.value='hello'; input.dispatchEvent(new InputEvent('input',{data:'hello',inputType:'insertText',bubbles:true}));
            input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
            input.value='に'; input.dispatchEvent(new InputEvent('input',{data:'に',inputType:'insertCompositionText',isComposing:true,bubbles:true}));
            input.dispatchEvent(new CompositionEvent('compositionend',{data:'日本',bubbles:true}));
            input.value='日本'; input.dispatchEvent(new InputEvent('input',{data:'日本',inputType:'insertText',bubbles:true}));
            const clip=new DataTransfer(); clip.setData('text/plain','paste\\nline');
            input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:clip,bubbles:true,cancelable:true}));`);
            assert.deepEqual(await value(page, "fixture.inputs.map(i=>i.events[0])"), [
                keyEvent({ key: "ArrowUp" }),
                { TextCommit: "hello" },
                { TextCommit: "日本" },
                { Paste: "paste\nline" },
            ]);
            assert.deepEqual(
                await value(page, "fixture.inputs.map(i=>[i.id,i.popup])"),
                Array(4).fill(["pane-left", false]),
            );
            assert.equal(
                await value(
                    page,
                    `(() => {const e=new KeyboardEvent('keydown',{key:'r',metaKey:true,cancelable:true,bubbles:true});document.querySelector('.terminal-grid-input').dispatchEvent(e);return e.defaultPrevented})()`,
                ),
                false,
            );
            await page.evaluate(
                `fixture.inputs=[]; fixture.point('pointerdown',0,0); fixture.point('pointermove',10,0); fixture.point('pointerup',10,0);`,
            );
            await settle(page);
            assert.equal(
                await value(page, "document.querySelector('.terminal-grid-selection')?.value"),
                "Herdr struc",
            );
            assert.equal(await value(page, "fixture.inputs.length"), 0);
            await page.evaluate(
                `fixture.point('pointerdown',34,2,{altKey:true}); fixture.point('pointerup',34,2,{altKey:true});`,
            );
            assert.deepEqual(await value(page, "fixture.actions.at(-1)"), {
                type: "focus-pane",
                paneId: "pane-right",
            });
            await page.evaluate(`fixture.point('pointerdown',1,6,{ctrlKey:true}); fixture.point('pointerup',1,6,{ctrlKey:true});
            fixture.point('pointerdown',7,6,{ctrlKey:true}); fixture.point('pointerup',7,6,{ctrlKey:true});`);
            assert.equal(await value(page, "fixture.opened.length"), 1);
            assert.equal(await value(page, "fixture.opened[0][0]"), "https://example.com/docs");
            await page.evaluate(
                `fixture.props.surface.panes[0].mouse_reporting=true; fixture.draw({surface:{...fixture.props.surface}});`,
            );
            await settle(page);
            await page.evaluate(
                `fixture.inputs=[];fixture.point('pointerdown',1,2);fixture.point('pointermove',2,2);fixture.point('pointerup',3,2);`,
            );
            assert.deepEqual(await value(page, "fixture.inputs.map(i=>i.events[0].Mouse.kind)"), [
                { Down: "Left" },
                { Drag: "Left" },
                { Up: "Left" },
            ]);
            await page.evaluate(`fixture.inputs=[]; const c=document.querySelector('canvas'),r=c.getBoundingClientRect();
            c.dispatchEvent(new WheelEvent('wheel',{clientX:r.left+10,clientY:r.top+20,deltaY:-40,bubbles:true,cancelable:true}));`);
            assert.equal(await value(page, "fixture.inputs[0].events[0].Mouse.kind"), "ScrollUp");
            assert.equal(await value(page, "fixture.inputs[0].events[0].Mouse.lines"), 2);

            for (const shape of [1, 2, 3, 4, 5, 6]) {
                await page.evaluate(
                    `fixture.props.surface.frame.cursor.shape=${shape};fixture.draw({surface:{...fixture.props.surface}});`,
                );
                await settle(page);
                assert.equal(
                    await value(
                        page,
                        "document.querySelector('.terminal-grid-cursor').dataset.shape",
                    ),
                    String(shape),
                );
                assert.equal(
                    await value(
                        page,
                        "document.querySelector('.terminal-grid-cursor').style.height",
                    ),
                    shape === 3 || shape === 4 ? "2px" : "20px",
                );
            }

            await page.evaluate(
                `fixture.props.surface.frame.cursor.visible=false;fixture.draw({surface:{...fixture.props.surface}});`,
            );
            await settle(page);
            assert.equal(
                await value(page, "!!document.querySelector('.terminal-grid-cursor')"),
                false,
            );
            await page.setViewport(VIEWPORTS.mobile);
            await settle(page);
            assert.equal(
                await value(
                    page,
                    "getComputedStyle(document.querySelector('.terminal-grid-keybar')).display",
                ),
                "flex",
                "mobile helper keys remain available",
            );
            assert.equal(
                await value(page, "document.documentElement.scrollWidth <= innerWidth"),
                true,
            );
            await page.evaluate(
                `fixture.inputs=[];document.querySelector('button[aria-label="Control"]').click();`,
            );
            await settle(page);
            await page.evaluate(
                `const i=document.querySelector('.terminal-grid-input');i.value='c';i.dispatchEvent(new InputEvent('input',{data:'c',bubbles:true}));`,
            );
            assert.deepEqual(await value(page, "fixture.inputs[0].events[0].Key.code"), {
                Char: "c",
            });
            assert.equal(await value(page, "fixture.inputs[0].events[0].Key.modifiers"), 2);
            await shot(page, "mobile");
            await page.evaluate(`fixture.inputs=[]; fixture.draw({reportAllKeys:true});`);
            await settle(page);
            await page.evaluate(`const i=document.querySelector('.terminal-grid-input');i.focus();
            i.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true,cancelable:true}));
            i.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowDown',code:'ArrowDown',bubbles:true,cancelable:true}));
            i.dispatchEvent(new InputEvent('beforeinput',{inputType:'deleteContentBackward',bubbles:true,cancelable:true}));`);
            assert.deepEqual(await value(page, "fixture.inputs.map(i=>i.events[0].Key.kind)"), [
                "Press",
                "Release",
                "Press",
            ]);
            assert.equal(await value(page, "fixture.inputs[2].events[0].Key.code"), "Backspace");
            await page.evaluate(`const frame={...fixture.props.surface.frame,width:8,height:4,cells:fixture.props.surface.frame.cells.slice(0,32),cursor:{x:1,y:1,shape:6,visible:true}};
            fixture.inputs=[];fixture.draw({surface:{...fixture.props.surface,popup:{terminal_id:'popup-id',title:'Popup fixture',frame,mouse_reporting:false,sgr_pixel_mouse:false,pixel_width:80,pixel_height:80}}});`);
            await settle(page);
            await page.evaluate(
                `const i=document.querySelector('.terminal-grid-input');i.focus();i.value='popup';i.dispatchEvent(new InputEvent('input',{data:'popup',bubbles:true}));`,
            );
            assert.deepEqual(await value(page, "fixture.inputs[0]"), {
                id: "popup-id",
                popup: true,
                events: [{ TextCommit: "popup" }],
            });
            assert.equal(
                await value(
                    page,
                    "document.querySelector('.terminal-grid-popup-title').textContent",
                ),
                "Popup fixture",
            );
            await page.evaluate(`fixture.draw({surface:{...fixture.props.surface,popup:null}});`);
            await settle(page);
            await page.evaluate(`const key={source:{Terminal:{target:{Pane:{pane_id:'pane-left'}},image_id:1}},image_width:1,image_height:1,format:'Rgb',data_len:3,data_fingerprint:'18446744073709551615'};
            const placement={asset:key,logical_placement_id:1,x:0,y:10,cols:2,rows:1,source_x:0,source_y:0,source_width:0,source_height:0,x_offset:0,y_offset:0,z:1,scrollback_offset:0};
            fixture.draw({images:[{key,serial:1,encoding:'base64',data:'/wAA'}],surface:{...fixture.props.surface,graphics:{assets:[],placements:[placement],retained_assets:[]}}});`);
            await settle(page);
            assert.deepEqual(
                await value(
                    page,
                    `(() => {const c=document.querySelector('canvas');return [...c.getContext('2d').getImageData(c.width/640*5,c.height/280*205,1,1).data]})()`,
                ),
                [255, 0, 0, 255],
            );
            await page.evaluate(`const tile=document.createElement('canvas');tile.width=tile.height=1;
                const ctx=tile.getContext('2d');ctx.fillStyle='#00ff00';ctx.fillRect(0,0,1,1);
                const data=tile.toDataURL('image/png').split(',')[1];
                const key={...fixture.props.images[0].key,format:'Png',data_len:atob(data).length,data_fingerprint:'18446744073709551614'};
                const placement={...fixture.props.surface.graphics.placements[0],asset:key};
                fixture.draw({images:[{key,serial:2,encoding:'base64',data}],surface:{...fixture.props.surface,graphics:{assets:[],placements:[placement],retained_assets:[]}}});`);
            await settle(page);
            assert.deepEqual(
                await value(
                    page,
                    `(() => {const c=document.querySelector('canvas');return [...c.getContext('2d').getImageData(c.width/640*5,c.height/280*205,1,1).data]})()`,
                ),
                [0, 255, 0, 255],
            );
            await page.evaluate(`fixture.pasteImage = (type = 'image/png', delay = false) => {
                const bytes=Uint8Array.from(atob(fixture.props.images[0].data),c=>c.charCodeAt(0));
                const file=new File([bytes],'clipboard.png',{type});
                if (delay) { file.arrayBuffer=()=>new Promise(resolve=>{fixture.finishImageRead=()=>resolve(bytes.buffer)}); }
                const data=new DataTransfer();data.items.add(file);
                document.querySelector('.terminal-grid-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
            }; fixture.pasteImage();`);
            await settle(page);
            assert.equal(await value(page, "fixture.pastedImages.length"), 1);
            assert.equal(await value(page, "fixture.pastedImages[0].id"), "pane-left");
            assert.equal(await value(page, "fixture.pastedImages[0].popup"), false);
            assert.deepEqual(await value(page, "fixture.pastedImages[0].image"), {
                encoding: "base64",
                format: "png",
                data: await value<string>(page, "fixture.props.images[0].data"),
            });
            await page.evaluate(`fixture.pasteImage('image/jpeg');`);
            await settle(page);
            assert.match(
                await value<string>(
                    page,
                    "document.querySelector('.terminal-grid-notice').textContent",
                ),
                /Only PNG/,
            );
            assert.equal(await value(page, "fixture.pastedImages.length"), 1);
            await page.evaluate(`fixture.draw({onPasteImage:null});`);
            await settle(page);
            await page.evaluate(`fixture.pasteImage();`);
            await settle(page);
            assert.match(
                await value<string>(
                    page,
                    "document.querySelector('.terminal-grid-notice').textContent",
                ),
                /unavailable/,
            );
            await page.evaluate(`fixture.draw({onPasteImage:undefined});`);
            await settle(page);
            await page.evaluate(
                `fixture.pasteImage('image/png',true);fixture.draw({surface:{...fixture.props.surface,boot_id:'new-synthetic-boot'}});fixture.finishImageRead();`,
            );
            await settle(page);
            assert.equal(
                await value(page, "fixture.pastedImages.length"),
                1,
                "stale image paste never crosses a target change",
            );
            await page.evaluate(`fixture.inputs=[];fixture.pasteImage('image/png',true);
                const i=document.querySelector('.terminal-grid-input');i.focus();i.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));i.value='old-stream';
                fixture.draw({enabled:false,inputEpoch:40});`);
            await settle(page);
            await page.evaluate(`fixture.draw({enabled:true,inputEpoch:41});`);
            await settle(page);
            await page.evaluate(`fixture.finishImageRead();const i=document.querySelector('.terminal-grid-input');
                i.dispatchEvent(new CompositionEvent('compositionend',{data:'old-stream',bubbles:true}));i.value='old-stream';i.dispatchEvent(new InputEvent('input',{data:'old-stream',bubbles:true}));`);
            await settle(page);
            assert.equal(
                await value(page, "fixture.pastedImages.length"),
                1,
                "a clipboard read from the old connection never replays into the same boot and pane",
            );
            assert.equal(
                await value(page, "fixture.inputs.length"),
                0,
                "late composition commit from an old input epoch is discarded",
            );
            await page.evaluate(
                `const i=document.querySelector('.terminal-grid-input');i.focus();i.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));i.dispatchEvent(new CompositionEvent('compositionend',{data:'fresh',bubbles:true}));`,
            );
            assert.deepEqual(await value(page, "fixture.inputs.map(i=>i.events[0])"), [
                { TextCommit: "fresh" },
            ]);
            await page.evaluate(`const frame={...fixture.props.surface.frame,width:2,height:2,cells:fixture.props.surface.frame.cells.slice(0,4),cursor:null};
                fixture.draw({surface:{...fixture.props.surface,popup:{terminal_id:'image-popup',title:'Image paste popup',frame,mouse_reporting:false,sgr_pixel_mouse:false,pixel_width:20,pixel_height:40}}});`);
            await settle(page);
            await page.evaluate(`fixture.pasteImage();`);
            await settle(page);
            assert.equal(await value(page, "fixture.pastedImages.length"), 2);
            assert.deepEqual(
                await value(page, "[fixture.pastedImages[1].id,fixture.pastedImages[1].popup]"),
                ["image-popup", true],
            );
            await page.evaluate(
                `fixture.inputs=[]; fixture.draw({enabled:false,clipboardOffer:'request, not automatic copy',surface:{...fixture.props.surface,popup:null}});`,
            );
            await settle(page);
            const count = await value<number>(page, "fixture.sizes.length");

            await page.evaluate(`fixture.pasteImage();`);
            await settle(page);
            assert.equal(
                await value(page, "fixture.pastedImages.length"),
                2,
                "disabled image paste sends nothing",
            );

            await page.evaluate(`const i=document.querySelector('.terminal-grid-input');i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
            i.value='blocked';i.dispatchEvent(new InputEvent('input',{data:'blocked',bubbles:true}));
            fixture.point('pointerdown',34,2,{altKey:true}); fixture.point('pointerup',34,2,{altKey:true});`);
            await page.setViewport(VIEWPORTS.desktop);
            await settle(page);
            assert.equal(
                await value(page, "fixture.sizes.length"),
                count,
                "no disabled resize callback",
            );
            assert.equal(await value(page, "fixture.inputs.length"), 0);
            assert.equal(
                await value(page, "document.querySelector('.terminal-grid-input').disabled"),
                true,
            );
            assert.equal(
                await value(page, "fixture.copied.length"),
                0,
                "clipboard offer never writes automatically",
            );
            assert.deepEqual(
                page.logs().filter((entry) => entry.level === "error"),
                [],
            );
        } finally {
            await browsers.closeAll({ final: true });
            fixture.server.closeAllConnections();
            await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
            rmSync(dir, { recursive: true, force: true });
        }
    },
);
