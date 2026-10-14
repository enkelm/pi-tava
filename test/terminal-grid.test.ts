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

async function mobileKeyboard(page: BrowserPage) {
    // Ordinary gestures use CDP. Distinct touch IDs use PointerEvents below because
    // BrowserPage exposes mouse input (including held presses), but no touch dispatch API.
    const tap = async (label: string) => {
        const result = await page.click({ label });

        assert.equal(result.covered, undefined, `${label} is not covered`);
    };

    const touchSequence = async (labels: readonly string[], sequence: string) => {
        await page.evaluate(`const buttons=${JSON.stringify(labels)}.map(label=>
            document.querySelector('.terminal-keyboard button[aria-label="'+label+'"]'));
            const saved=buttons.map(button=>({button,
                descriptor:Object.getOwnPropertyDescriptor(button,'setPointerCapture')}));
            for(const {button} of saved){button.setPointerCapture=()=>{}}
            try {
                const point=(index,type)=>{const b=buttons[index],r=b.getBoundingClientRect();
                    b.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,
                        pointerId:41+index,pointerType:'touch',isPrimary:index===0,
                        button:0,buttons:type==='pointerdown'?1:0,detail:type==='click'?1:0,
                        clientX:r.left+r.width/2,clientY:r.top+r.height/2}));};
                ${sequence}
            } finally {
                for(const {button,descriptor} of saved){
                    if(descriptor){Object.defineProperty(button,'setPointerCapture',descriptor)}
                    else{delete button.setPointerCapture}
                }
            }`);
    };

    const expectInputs = async (
        events: unknown[],
        id = "pane-left",
        popup = false,
        description = "virtual keyboard delivers expected protocol events",
    ) => {
        assert.deepEqual(
            await value(
                page,
                `fixture.inputs.flatMap(i=>i.events.map(e=>e.Key
                    ? [e.Key.code,e.Key.modifiers,e.Key.kind,e.Key.tracks_release] : e))`,
            ),
            events,
            description,
        );
        assert.equal(
            await value(
                page,
                `fixture.inputs.every(i=>i.id===${JSON.stringify(id)}&&i.popup===${popup})`,
            ),
            true,
            "every callback goes to the current terminal target",
        );
        await page.evaluate("fixture.inputs=[]");
    };

    const modifierState = async (label: string, pressed: boolean, locked = false) => {
        assert.deepEqual(
            await value(
                page,
                `(() => {const b=document.querySelector('button[aria-label="${label}"]');
                    return [b.getAttribute('aria-pressed')==='true',b.dataset.locked==='true']})()`,
            ),
            [pressed, locked],
            `${label} exposes its one-shot/locked state`,
        );
    };

    const inputMode = async (native = false) => {
        assert.deepEqual(
            await value(
                page,
                `(() => {const i=document.querySelector('.terminal-grid-input');
                    return [i.readOnly,${native} ? i.inputMode!=='none' : i.inputMode==='none',i.disabled]})()`,
            ),
            [!native, true, false],
        );
    };

    const layout = async () => {
        assert.equal(
            await value(
                page,
                `(() => {const k=document.querySelector('.terminal-keyboard');
                    const v=document.querySelector('.terminal-grid-viewport');
                    const r=k.getBoundingClientRect(),vr=v.getBoundingClientRect();
                    const visible=[...k.querySelectorAll('button')].filter(b=>b.getClientRects().length);
                    return getComputedStyle(k).display!=='none' && r.height>0 && vr.height>=100 &&
                        vr.bottom<=r.top+1 && r.left>=0 && r.right<=innerWidth+1 &&
                        r.bottom<=innerHeight+1 && document.documentElement.scrollWidth<=innerWidth &&
                        visible.length>0 && visible.every(b=>{const br=b.getBoundingClientRect();
                            return br.width>0 && br.height>0 && br.left>=r.left-1 &&
                                br.right<=r.right+1 && br.top>=r.top-1 && br.bottom<=r.bottom+1 &&
                                (document.elementFromPoint(br.left+br.width/2,br.top+br.height/2)===b ||
                                 b.contains(document.elementFromPoint(br.left+br.width/2,br.top+br.height/2)))})})()`,
            ),
            true,
            "the keyboard and all visible buttons fit below a usable, non-overlapping terminal",
        );
    };

    const constrainedLayout = async () => {
        const originalStyle = await value<string>(
            page,
            "document.querySelector('#fixture').style.cssText",
        );

        try {
            await page.setViewport({ width: 844, height: 390, scale: 2, mobile: true });
            await page.evaluate(`const f=document.querySelector('#fixture');
                f.style.height='209px';f.style.minHeight='0';`);
            await settle(page);
            assert.equal(await value(page, "document.querySelector('#fixture').clientHeight"), 209);
            await inputMode();

            for (const tab of ["Letters", "Symbols", "Function keys"]) {
                await tap(tab);
                const labels = await value<string[]>(
                    page,
                    `[...document.querySelectorAll('.terminal-keyboard button')]
                        .map(b=>b.getAttribute('aria-label')||b.textContent.trim())`,
                );

                assert.ok(labels.length > 0);

                for (const [index, label] of labels.entries()) {
                    await page.evaluate(`document.querySelectorAll('.terminal-keyboard button')[${index}]
                        .scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
                        await new Promise(resolve=>requestAnimationFrame(resolve));`);
                    assert.deepEqual(
                        await value(
                            page,
                            `(() => {const b=document.querySelectorAll('.terminal-keyboard button')[${index}];
                                const br=b.getBoundingClientRect(),hit=document.elementFromPoint(br.left+br.width/2,br.top+br.height/2);
                                const fr=document.querySelector('#fixture').getBoundingClientRect();
                                const kr=document.querySelector('.terminal-keyboard').getBoundingClientRect();
                                const vr=document.querySelector('.terminal-grid-viewport').getBoundingClientRect();
                                return [
                                    br.width>0 && br.height>0 && br.left>=kr.left-1 && br.right<=kr.right+1 &&
                                        br.top>=kr.top-1 && br.bottom<=kr.bottom+1 && (hit===b||b.contains(hit)),
                                    vr.height>=100 && vr.top>=fr.top-1 && vr.bottom<=kr.top+1,
                                    kr.height>0 && kr.top>=fr.top && kr.bottom<=fr.bottom+1 &&
                                        kr.left>=0 && kr.right<=innerWidth+1 && fr.bottom<=innerHeight+1,
                                ]})()`,
                        ),
                        [true, true, true],
                        `${tab}/${label}: every key is reachable without clipping or losing the useful terminal area`,
                    );
                }
            }

            await tap("Letters");
            await expectInputs([]);
        } finally {
            await page.evaluate(`document.querySelector('#fixture').style.cssText=${JSON.stringify(originalStyle)};
                document.querySelector('.terminal-keyboard').scrollTop=0;
                document.querySelector('.terminal-grid').scrollTop=0;
                document.querySelector('.terminal-grid-viewport').scrollTop=0;`);
            await page.setViewport(VIEWPORTS.mobile);
            await settle(page);
        }
    };

    await page.evaluate(`fixture.inputs=[];fixture.keyboardBase=structuredClone(fixture.props.surface);
        fixture.keyboardBase.panes=fixture.keyboardBase.panes.map(p=>({...p,mouse_reporting:false}));
        fixture.draw({surface:fixture.keyboardBase,reportAllKeys:false,inputEpoch:1});`);
    await settle(page);
    assert.equal(
        await value(page, "!!document.querySelector('.terminal-keyboard')"),
        true,
        "mobile provides the full touch keyboard, not just the old helper keybar",
    );
    await inputMode();
    await mobilePaste(page);
    await touchGestures(page);

    for (const cancelFirst of [false, true]) {
        await touchSequence(
            ["a", "s"],
            `point(0,'pointerdown');point(1,'pointerdown');
                if(${cancelFirst}){point(0,'pointercancel')}
                else{point(0,'pointerup');point(0,'click')}
                point(1,'pointerup');point(1,'click');`,
        );
        await expectInputs(
            cancelFirst ? [{ TextCommit: "s" }] : [{ TextCommit: "a" }, { TextCommit: "s" }],
            "pane-left",
            false,
            cancelFirst
                ? "cancelling one touch does not discard the other finger's letter"
                : "overlapping touch-downs deliver both letters in release order",
        );
    }

    for (const redraw of [false, true]) {
        for (const [character, text] of [
            ["a", "A"],
            ["1", "!"],
        ] as const) {
            await touchSequence(
                ["Shift", character],
                `point(0,'pointerdown');point(1,'pointerdown');
                    point(0,'pointerup');point(0,'click');
                    ${redraw ? "await new Promise(resolve=>requestAnimationFrame(resolve));" : ""}
                    point(1,'pointerup');point(1,'click');`,
            );
            await expectInputs(
                [{ TextCommit: text }],
                "pane-left",
                false,
                `Shift released while ${character} is held commits ${text} once ${redraw ? "after redraw" : "without redraw"}`,
            );
            await modifierState("Shift", false);
        }
    }

    await layout();
    await page.setViewport({ width: 320, height: 568, scale: 2, mobile: true });
    await settle(page);
    await layout();
    await page.setViewport(VIEWPORTS.mobile);
    await settle(page);
    await constrainedLayout();
    await layout();
    const canvasPoint = await value<{ x: number; y: number }>(
        page,
        `(() => {const r=document.querySelector('canvas').getBoundingClientRect();
            return {x:r.left+11,y:r.top+41}})()`,
    );

    await page.click(canvasPoint);
    assert.equal(await value(page, "document.activeElement.matches('.terminal-grid-input')"), true);
    await inputMode();
    await page.input([{ type: "text", text: "native-must-not-open" }]);
    assert.equal(await value(page, "document.querySelector('.terminal-grid-input').value"), "");
    await expectInputs([]);
    await page.press("q");
    await expectInputs(
        [{ TextCommit: "q" }],
        "pane-left",
        false,
        "hardware keydown still types while native text insertion is suppressed",
    );
    await inputMode();

    await page.evaluate(
        `document.querySelector('.terminal-keyboard button[aria-label="q"]').focus()`,
    );

    for (const key of ["Enter", "Space"]) {
        await page.press(key);
        await expectInputs(
            [{ TextCommit: "q" }],
            "pane-left",
            false,
            `${key} activates the focused virtual q button`,
        );
        assert.equal(
            await value(
                page,
                `document.activeElement.matches('.terminal-keyboard button[aria-label="q"]')`,
            ),
            true,
            "keyboard activation retains focus on the virtual button, not the hidden terminal input",
        );
    }

    await page.press("Tab");
    await expectInputs(
        [],
        "pane-left",
        false,
        "Tab navigates virtual controls rather than reaching the PTY",
    );
    assert.equal(
        await value(
            page,
            `document.activeElement.matches('.terminal-keyboard button') &&
            document.activeElement.getAttribute('aria-label')!=='q'`,
        ),
        true,
        "Tab advances to another keyboard control",
    );
    await inputMode();

    for (const label of ["q", "Enter", "Control", "Backspace"]) {
        const at = await page.locate({ label });

        await page.input([
            { type: "mouse", action: "down", x: at.x, y: at.y },
            { type: "mouse", action: "move", x: at.x, y: at.y + 50, pressed: true },
        ]);

        // Let a repeatable key's hold deadline expire after the drag has cancelled it.
        if (label === "Backspace") {
            await page.evaluate("await new Promise(resolve=>setTimeout(resolve,700))");
        }

        await page.input([{ type: "mouse", action: "up", x: at.x, y: at.y }]);
        await expectInputs(
            [],
            "pane-left",
            false,
            `dragging ${label} cancels the tap without sending accidental input`,
        );
        await modifierState("Control", false);
    }

    await page.evaluate("document.querySelector('#outside').focus()");
    await tap("a");
    assert.equal(await value(page, "document.activeElement.matches('.terminal-grid-input')"), true);
    await tap("z");
    await tap("Space");
    await expectInputs([{ TextCommit: "a" }, { TextCommit: "z" }, { TextCommit: " " }]);
    assert.equal(await value(page, "document.activeElement.matches('.terminal-grid-input')"), true);
    await inputMode();

    for (const [label, code] of [
        ["Enter", "Enter"],
        ["Escape", "Esc"],
        ["ArrowLeft", "Left"],
        ["ArrowUp", "Up"],
        ["ArrowDown", "Down"],
        ["ArrowRight", "Right"],
        ["Backspace", "Backspace"],
        ["Tab", "Tab"],
    ] as const) {
        await tap(label);
        await expectInputs([[code, 0, "Press", false]]);
    }

    for (const [label, mask, display] of [
        ["Control", 2, "Ctrl"],
        ["Alt", 4, "Alt"],
        ["Meta", 8, "Cmd"],
    ] as const) {
        assert.equal(
            await value(
                page,
                `document.querySelector('button[aria-label="${label}"]').textContent.trim()`,
            ),
            display,
        );
        await tap(label);
        await modifierState(label, true);
        await expectInputs([]);
        await tap("a");
        await modifierState(label, false);
        await tap("a");
        await expectInputs([[{ Char: "a" }, mask, "Press", false], { TextCommit: "a" }]);
        await tap(label);
        await tap(label);
        await modifierState(label, true, true);
        await tap("a");
        await tap("z");
        await expectInputs([
            [{ Char: "a" }, mask, "Press", false],
            [{ Char: "z" }, mask, "Press", false],
        ]);
        await modifierState(label, true, true);
        await tap(label);
        await modifierState(label, false);
    }

    await tap("Control");
    await tap("Alt");
    await tap("Meta");
    await tap("a");
    await expectInputs([[{ Char: "a" }, 14, "Press", false]]);
    await tap("Shift");
    await modifierState("Shift", true);
    assert.equal(
        await value(
            page,
            `document.querySelector('button[aria-label="a"]')?.textContent.trim() ?? null`,
        ),
        "A",
        "Shift changes the displayed letter, not its accessible label",
    );
    await tap("a");
    await modifierState("Shift", false);
    await tap("a");
    await expectInputs([{ TextCommit: "A" }, { TextCommit: "a" }]);
    await tap("Shift");
    await tap("Shift");
    await tap("a");
    await tap("z");
    await expectInputs([{ TextCommit: "A" }, { TextCommit: "Z" }]);
    await modifierState("Shift", true, true);
    await tap("Shift");
    await tap("Shift");
    await tap("Control");
    await tap("Alt");
    await tap("Meta");
    await tap("a");
    await expectInputs([[{ Char: "A" }, 15, "Press", false]]);
    await tap("Shift");
    await tap("Tab");
    await expectInputs([["BackTab", 1, "Press", false]]);
    await modifierState("Shift", false);

    await tap("1");
    await expectInputs([{ TextCommit: "1" }]);
    await tap("Shift");
    // Symbol accessible names may follow their displayed character; letters retain labels a-z.
    const symbolPoint = await value<{ x: number; y: number }>(
        page,
        `(() => {const b=[...document.querySelectorAll('.terminal-keyboard button')]
            .find(b=>b.textContent.trim()==='!');const r=b.getBoundingClientRect();
            return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
    );

    await page.click(symbolPoint);
    await expectInputs([{ TextCommit: "!" }]);
    await modifierState("Shift", false);
    await tap("Symbols");
    await expectInputs([]);
    await layout();
    await tap("!");
    await expectInputs([{ TextCommit: "!" }]);
    await tap("Function keys");
    await layout();
    await tap("F1");
    await tap("F12");
    await expectInputs([
        [{ F: 1 }, 0, "Press", false],
        [{ F: 12 }, 0, "Press", false],
    ]);
    await tap("Letters");

    const expandedHeight = await value<number>(
        page,
        "document.querySelector('.terminal-grid-viewport').clientHeight",
    );

    await tap("Hide keyboard");
    assert.ok(
        (await value<number>(
            page,
            "document.querySelector('.terminal-grid-viewport').clientHeight",
        )) > expandedHeight,
        "hiding keys returns space to the terminal",
    );
    assert.equal(
        await value(
            page,
            `!!document.querySelector('button[aria-label="a"]')?.getClientRects().length`,
        ),
        false,
    );
    await inputMode();
    await tap("Show keyboard");
    await layout();
    await tap("Control");
    await tap("Control");
    await modifierState("Control", true, true);
    await tap("Native keyboard");
    await inputMode(true);
    assert.deepEqual(
        await value(
            page,
            `Array.from(document.querySelectorAll('[aria-label="Keyboard type"] button'),
            b=>b.getAttribute('aria-pressed'))`,
        ),
        ["false", "true"],
        "both keyboard types stay visible with Native selected",
    );
    await tap("Hide keyboard");
    await inputMode();
    assert.notEqual(await value(page, "document.activeElement.className"), "terminal-grid-input");
    await tap("Show keyboard");
    await inputMode(true);
    assert.equal(await value(page, "document.activeElement.matches('.terminal-grid-input')"), true);
    await page.type(undefined, "native fallback");
    await expectInputs([{ TextCommit: "native fallback" }]);
    await tap("Touch keyboard");
    assert.deepEqual(
        await value(
            page,
            `Array.from(document.querySelectorAll('[aria-label="Keyboard type"] button'),
            b=>b.getAttribute('aria-pressed'))`,
        ),
        ["true", "false"],
        "switching back updates the selected segment without sending a terminal key",
    );
    await modifierState("Control", false);
    await inputMode();
    await layout();
    await tap("a");
    await expectInputs([{ TextCommit: "a" }]);

    await page.evaluate(`fixture.virtualShortcuts=[];
        fixture.draw({onShortcut:(e,c)=>{fixture.virtualShortcuts.push([e.key,c.targetId,c.popup,c.virtual]);
            if(e.key==='x'){e.preventDefault();return true}return false}});`);
    await settle(page);
    await tap("x");
    await expectInputs([]);
    await tap("Control");
    await tap("v");
    await tap("Meta");
    await tap("r");
    await tap("Shift");
    await tap("Escape");
    await expectInputs([
        [{ Char: "v" }, 2, "Press", false],
        [{ Char: "r" }, 8, "Press", false],
        ["Esc", 1, "Press", false],
    ]);
    assert.deepEqual(await value(page, "fixture.virtualShortcuts"), [
        ["x", "pane-left", false, true],
        ["v", "pane-left", false, true],
        ["r", "pane-left", false, true],
        ["Escape", "pane-left", false, true],
    ]);
    assert.equal(await value(page, "document.activeElement.matches('.terminal-grid-input')"), true);

    await page.evaluate(`fixture.retargetShortcut=[];
        fixture.draw({onShortcut:(e,c)=>{if(e.key.toLowerCase()==='x'){
            fixture.retargetShortcut.push([e.key,c.targetId]);
            fixture.focusRef.current.setTarget('pane-right');return true}return false}});`);
    await settle(page);

    for (const label of ["Control", "Alt", "Meta", "Shift"]) {
        await tap(label);
        await tap(label);
        await modifierState(label, true, true);
    }

    await tap("x");
    await expectInputs(
        [],
        "pane-left",
        false,
        "a synchronously retargeting shortcut consumes the key",
    );
    assert.deepEqual(await value(page, "fixture.retargetShortcut"), [["X", "pane-left"]]);

    for (const label of ["Control", "Alt", "Meta", "Shift"]) {
        await modifierState(label, false);
    }

    await tap("a");
    await expectInputs(
        [{ TextCommit: "a" }],
        "pane-right",
        false,
        "shortcut target reset clears locked modifiers before the next key",
    );
    await page.evaluate(`fixture.focusRef.current.setTarget('pane-left');
        fixture.draw({onShortcut:undefined,surface:{...fixture.props.surface}});`);
    await settle(page);

    await page.evaluate("fixture.draw({reportAllKeys:true,onShortcut:undefined})");
    await settle(page);
    await tap("Control");
    await tap("a");
    await tap("ArrowDown");
    await tap("a");
    await expectInputs([
        [{ Char: "a" }, 2, "Press", true],
        [{ Char: "a" }, 2, "Release", true],
        ["Down", 0, "Press", true],
        ["Down", 0, "Release", true],
        [{ Char: "a" }, 0, "Press", true],
        [{ Char: "a" }, 0, "Release", true],
    ]);

    // Hold a real pointer through each context change. Old repeat/release must not leak,
    // even when the connection epoch changes without changing the boot or pane identity.
    const transitions = [
        ["input epoch", "{inputEpoch:2}", "pane-left", false],
        [
            "focused pane",
            "{surface:{...fixture.props.surface,panes:fixture.props.surface.panes.map((p,i)=>({...p,focused:i===1}))}}",
            "pane-right",
            false,
        ],
        [
            "popup opens",
            "{surface:{...fixture.props.surface,popup:fixture.keyboardPopup}}",
            "keyboard-popup",
            true,
        ],
        [
            "popup identity",
            "{surface:{...fixture.props.surface,popup:{...fixture.keyboardPopup,terminal_id:'keyboard-popup-2'}}}",
            "keyboard-popup-2",
            true,
        ],
        ["popup closes", "{surface:{...fixture.props.surface,popup:null}}", "pane-right", false],
        ["local target", "fixture.focusRef.current.setTarget('pane-left')", "pane-left", false],
        ["disabled", "{disabled:true}", "pane-right", false],
        ["disconnected", "{enabled:false}", "pane-right", false],
    ] as const;

    await page.evaluate(`fixture.keyboardPopup={terminal_id:'keyboard-popup',title:'Touch popup',
        frame:{...fixture.props.surface.frame,width:8,height:4,cells:fixture.props.surface.frame.cells.slice(0,32),cursor:null},
        mouse_reporting:false,sgr_pixel_mouse:false,pixel_width:80,pixel_height:80};`);

    for (const [name, patch, id, popup] of transitions) {
        for (const label of ["Control", "Alt", "Meta", "Shift"]) {
            await tap(label);
            await tap(label);
            await modifierState(label, true, true);
        }

        const at = await page.locate({ label: "Backspace" });

        await page.input([{ type: "mouse", action: "down", x: at.x, y: at.y }]);
        await page.evaluate("await new Promise(resolve=>setTimeout(resolve,700))");
        assert.equal(
            await value(
                page,
                `fixture.inputs.flatMap(i=>i.events).some(e=>e.Key?.kind==='Repeat')`,
            ),
            true,
            `${name}: holding Backspace delivers real repeat input before cancellation`,
        );
        assert.equal(
            await value(
                page,
                `fixture.inputs.flatMap(i=>i.events).every((e,i,events)=>
                    e.Key?.code==='Backspace' && e.Key.modifiers===15 && e.Key.tracks_release &&
                    (i%2 ? e.Key.kind==='Release' :
                        ['Press','Repeat'].includes(e.Key.kind) && events[i+1]?.Key.kind==='Release'))`,
            ),
            true,
            "locked modifiers apply to repeats and every semantic stroke has a paired release",
        );
        await page.evaluate(
            `${name === "local target" ? patch : `fixture.draw(${patch})`};fixture.inputs=[];`,
        );
        await page.evaluate("await new Promise(resolve=>setTimeout(resolve,700))");
        await page.input([{ type: "mouse", action: "up", x: at.x, y: at.y }]);
        await settle(page);
        await expectInputs(
            [],
            id,
            popup,
            `${name}: context change cancels held repeat and release`,
        );

        if (name === "disabled" || name === "disconnected") {
            assert.equal(
                await value(page, "document.querySelector('.terminal-grid-input').disabled"),
                true,
            );
            await page.evaluate("fixture.draw({disabled:false,enabled:true})");
            await settle(page);
        }

        for (const label of ["Control", "Alt", "Meta", "Shift"]) {
            await modifierState(label, false);
        }

        await tap("a");
        await expectInputs(
            [
                [{ Char: "a" }, 0, "Press", true],
                [{ Char: "a" }, 0, "Release", true],
            ],
            id,
            popup,
        );
        await inputMode();
    }

    await shot(page, "mobile-keyboard");
    // The remaining cases intentionally exercise native IME/beforeinput and clipboard events.
    await page.evaluate("fixture.draw({surface:fixture.keyboardBase,reportAllKeys:false})");
    await settle(page);
    await tap("Native keyboard");
}

async function touchGestures(page: BrowserPage) {
    for (const mouseReporting of [false, true]) {
        await page.evaluate(`fixture.inputs=[];
            fixture.draw({surface:{...fixture.keyboardBase,
                panes:fixture.keyboardBase.panes.map(p=>({...p,mouse_reporting:${mouseReporting}}))}});`);
        await settle(page);
        await page.evaluate(`fixture.touch=(type,x,y)=>fixture.point(type,x,y,
            {pointerType:'touch',isPrimary:true,pointerId:61});
            fixture.touch('pointerdown',1,4);
            fixture.touch('pointermove',1,2);
            fixture.touch('pointerup',1,2);`);
        await settle(page);
        assert.deepEqual(
            await value(
                page,
                "fixture.inputs.map(i=>[i.id,i.events.map(e=>[e.Mouse.kind,e.Mouse.lines])])",
            ),
            [["pane-left", [["ScrollDown", 2]]]],
            `${mouseReporting ? "TUI" : "plain pane"}: a swipe scrolls without mouse clicks or selection`,
        );
        assert.equal(
            await value(page, "!!document.querySelector('.terminal-grid-selection')"),
            false,
        );
        await page.evaluate(`fixture.inputs=[];fixture.touch('pointerdown',1,0);
            await new Promise(resolve=>setTimeout(resolve,600));`);
        await settle(page);
        assert.equal(
            await value(page, "document.querySelector('.terminal-grid').dataset.touchSelecting"),
            "true",
            "a deliberate hold visibly activates local selection even in a mouse-reporting TUI",
        );
        assert.equal(
            await value(page, "!!document.querySelector('.terminal-grid-touch-cue')"),
            true,
        );
        await page.evaluate(`fixture.touch('pointermove',5,0);fixture.touch('pointerup',5,0);`);
        await settle(page);
        assert.equal(
            await value(page, "document.querySelector('.terminal-grid-selection')?.value"),
            "erdr",
            "selected terminal text omits trailing screen padding",
        );
        assert.equal(
            await value(page, "fixture.inputs.length"),
            0,
            "hold-selection never sends an application mouse-down or scroll",
        );
        assert.equal(
            await value(page, "!!document.querySelector('.terminal-grid-touch-cue')"),
            false,
        );
        await page.evaluate(`fixture.inputs=[];fixture.touch('pointerdown',1,2);`);
        assert.equal(
            await value(page, "fixture.inputs.length"),
            0,
            "touch-down waits for tap/scroll/hold intent before sending anything",
        );
        await page.evaluate(`fixture.touch('pointerup',1,2);`);
        assert.deepEqual(
            await value(page, "fixture.inputs.flatMap(i=>i.events.map(e=>e.Mouse.kind))"),
            mouseReporting ? [{ Down: "Left" }, { Up: "Left" }] : [],
            "a short tap still clicks a mouse-reporting application once",
        );
    }

    for (const selecting of [false, true]) {
        await page.evaluate(`fixture.inputs=[];fixture.touch('pointerdown',1,0);
            ${selecting ? "await new Promise(resolve=>setTimeout(resolve,600));" : ""}
            fixture.draw({inputEpoch:fixture.props.inputEpoch+1});
            await new Promise(resolve=>setTimeout(resolve,600));
            fixture.touch('pointerup',5,0);`);
        await settle(page);
        assert.equal(
            await value(page, "fixture.inputs.length"),
            0,
            "connection changes discard pending and active touch selection without replay",
        );
        assert.equal(
            await value(page, "document.querySelector('.terminal-grid').dataset.touchSelecting"),
            "false",
        );
        assert.equal(
            await value(page, "!!document.querySelector('.terminal-grid-selection')"),
            false,
        );
    }

    await page.evaluate(
        `fixture.inputs=[];fixture.draw({surface:fixture.keyboardBase,inputEpoch:1});`,
    );
    await settle(page);
}

async function mobilePaste(page: BrowserPage) {
    const open = async (text = "") => {
        await page.click({ label: "Paste" });
        await settle(page);
        assert.equal(
            await value(
                page,
                "document.activeElement.matches('.terminal-keyboard-paste textarea')",
            ),
            true,
            "Paste opens a focused, editable field for the native paste menu",
        );
        await page.type({ label: "Text to paste" }, text);
    };

    const text = "echo 'hello'\n日本語 👩‍💻\n";

    await page.evaluate(`fixture.point('pointerdown',1,0,{shiftKey:true});
        fixture.point('pointermove',5,0,{shiftKey:true});
        fixture.point('pointerup',5,0,{shiftKey:true});`);
    await settle(page);
    assert.equal(
        await value(page, "document.querySelector('.terminal-grid-selection')?.value"),
        "erdr",
        "a terminal selection remains available while opening the separate paste editor",
    );
    await open(text);
    assert.deepEqual(
        await value(
            page,
            `(() => {
            const data=new DataTransfer();
            data.setData('text/plain','draft copy');
            const event=new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data});
            document.querySelector('.terminal-keyboard-paste textarea').dispatchEvent(event);
            return {prevented:event.defaultPrevented,text:data.getData('text/plain')};
        })()`,
        ),
        { prevented: false, text: "draft copy" },
        "Copy in the editable paste field stays browser-owned, not replaced by terminal selection",
    );
    assert.deepEqual(
        await value(
            page,
            `(() => {
            const data=new DataTransfer();
            const event=new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data});
            document.querySelector('.terminal-grid-input').dispatchEvent(event);
            return {prevented:event.defaultPrevented,text:data.getData('text/plain')};
        })()`,
        ),
        { prevented: true, text: "erdr" },
        "Copy from the terminal input still uses the selected terminal cells",
    );
    assert.equal(
        await value(page, "fixture.inputs.length"),
        0,
        "editing never types into the pane",
    );
    await shot(page, "mobile-paste");
    await page.click({ label: "Paste into pane" });
    await settle(page);
    assert.deepEqual(await value(page, "fixture.inputs"), [
        { id: "pane-left", events: [{ Paste: text }], popup: false },
    ]);
    assert.equal(
        await value(page, "document.activeElement.matches('.terminal-grid-input')"),
        true,
        "sending restores terminal input focus without an extra Enter",
    );
    await page.evaluate("fixture.inputs=[]");

    await open("discard me");
    await page.click({ label: "Cancel paste" });
    await settle(page);
    assert.equal(await value(page, "fixture.inputs.length"), 0);
    await open();
    assert.equal(
        await value(page, "document.querySelector('.terminal-keyboard-paste textarea').value"),
        "",
        "cancelled text is not retained",
    );
    assert.equal(
        await value(page, "document.querySelector('.terminal-keyboard-paste button').disabled"),
        true,
        "empty text cannot be sent",
    );
    await page.press("Escape");
    await settle(page);

    // The real send boundary owns the UTF-8 limit, including native paste events.
    await open();
    await page.evaluate(`const field=document.querySelector('.terminal-keyboard-paste textarea');
        field.value='界'.repeat(Math.floor(${MAX_SELECTION_BYTES}/3)+1);
        field.dispatchEvent(new InputEvent('input',{bubbles:true}));`);
    await page.click({ label: "Paste into pane" });
    await settle(page);
    assert.equal(await value(page, "fixture.inputs.length"), 0, "oversized UTF-8 paste is refused");
    assert.match(
        await value<string>(page, "document.querySelector('[role=status]').textContent"),
        /1 MiB/,
    );
    await page.click({ label: "Cancel paste" });

    const base = await value(page, "fixture.props.surface");

    for (const change of [
        "fixture.draw({inputEpoch:fixture.props.inputEpoch+1})",
        "fixture.draw({surface:{...fixture.props.surface,boot_id:'paste-restarted'}})",
        "fixture.draw({surface:{...fixture.props.surface,panes:fixture.props.surface.panes.map((p,i)=>({...p,focused:i===1}))}})",
        "fixture.draw({surface:{...fixture.props.surface,popup:{terminal_id:'paste-popup',title:'Paste popup',frame:fixture.props.surface.frame}}})",
        "fixture.focusRef.current.setTarget('pane-right')",
        "fixture.draw({disabled:true})",
        "fixture.draw({enabled:false})",
    ]) {
        await open("must not cross targets");
        await page.evaluate(`${change};`);
        await settle(page);
        assert.equal(
            await value(page, "!!document.querySelector('.terminal-keyboard-paste')"),
            false,
            `target/connection/access changes discard the open paste: ${change}`,
        );
        assert.equal(await value(page, "fixture.inputs.length"), 0);
        await page.evaluate(
            `fixture.draw({surface:${JSON.stringify(base)},inputEpoch:1,enabled:true,disabled:false});`,
        );
        await settle(page);
    }

    await page.evaluate(
        `fixture.draw({surface:{...fixture.props.surface,popup:{terminal_id:'paste-popup',title:'Paste popup',frame:fixture.props.surface.frame}}});`,
    );
    await settle(page);
    await open("popup text");
    await page.click({ label: "Paste into pane" });
    assert.deepEqual(await value(page, "fixture.inputs"), [
        { id: "paste-popup", events: [{ Paste: "popup text" }], popup: true },
    ]);
    await page.evaluate(`fixture.inputs=[];fixture.draw({surface:${JSON.stringify(base)}});`);
    await settle(page);
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
    "Chromium desktop/mobile: canvas, IME, shortcuts, paste, selection, mouse, keyboard, popups, disabled mode and cleanup",
    {
        skip: findBrowser() ? false : "No Chromium installed",
        timeout: 120_000,
    },
    async (t) => {
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
                    "document.querySelector('.terminal-keyboard') ? getComputedStyle(document.querySelector('.terminal-keyboard')).display : null",
                ),
                "none",
                "desktop touch keyboard is hidden by CSS",
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
            await t.test(
                "full mobile keyboard: trusted clicks, modifiers, native fallback and context clearing",
                async () => mobileKeyboard(page),
            );
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
