// Touch terminal keyboard. Modifiers and repeat are local intent, never buffered across targets.
import { h } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);
const emptyModifiers = () => ({ shiftKey: 0, ctrlKey: 0, altKey: 0, metaKey: 0 });
const modifierKeys = [
    ["ctrlKey", "Control", "Ctrl"],
    ["altKey", "Alt", "Alt"],
    ["metaKey", "Meta", "Cmd"],
];
const shiftedNumbers = ")!@#$%^&*(";
const repeatable = new Set([
    "Backspace",
    "Delete",
    "ArrowLeft",
    "ArrowUp",
    "ArrowDown",
    "ArrowRight",
]);
const key = (value, label = value, width = 1) => ({ value, label, width });
const utility = [
    key("Escape", "Esc"),
    key("Tab"),
    key("Home"),
    key("End"),
    key("PageUp", "PgUp"),
    key("PageDown", "PgDn"),
    key("Delete", "Del"),
];
const letters = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const symbols = ["!@#$%^&*()", "[]{}<>/\\|", "`~;:'\"-_=+"];

export function TerminalKeyboardControls({ disabled, native, open, onChange }) {
    return html`
        <div class="terminal-keyboard-controls">
            <div class="terminal-keyboard-types" role="group" aria-label="Keyboard type">
                ${[
                    [false, "Touch"],
                    [true, "Native"],
                ].map(
                    ([value, label]) => html`
                    <button type="button" disabled=${disabled}
                        aria-label=${`${label} keyboard`} aria-pressed=${native === value}
                        onPointerDown=${(event) => event.preventDefault()}
                        onClick=${() => onChange(value, true)}>${label}</button>`,
                )}
            </div>
            <button type="button" class="terminal-keyboard-collapse" disabled=${disabled}
                aria-label=${open ? "Hide keyboard" : "Show keyboard"} aria-expanded=${open}
                title=${open ? "Hide keyboard" : "Show keyboard"}
                onPointerDown=${(event) => event.preventDefault()}
                onClick=${() => onChange(native, !open)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round"
                    stroke-linejoin="round" aria-hidden="true">
                    <path d=${open ? "m6 9 6 6 6-6" : "m6 15 6-6 6 6"} />
                </svg>
            </button>
        </div>`;
}

export function TerminalKeyboard({
    disabled,
    contextKey,
    onKey,
    onPaste,
    native,
    open,
    onOpen,
    controls,
    pasteAction,
    pasteButtonRef,
    keyboardRef,
}) {
    const [layout, setLayout] = useState("letters");
    const [mods, setMods] = useState(emptyModifiers);
    const modifiers = useRef(mods);
    const repeating = useRef(null);
    const pressed = useRef(new Map());
    const lastReleased = useRef(null);
    const intentVersion = useRef(0);
    const current = useRef(null);
    const pasteTarget = useRef(null);
    const pasteField = useRef(null);
    const [pasting, setPasting] = useState(false);
    const [pasteText, setPasteText] = useState("");
    const shift = mods.shiftKey > 0;

    const clearPaste = () => {
        pasteTarget.current = null;
        setPasting(false);
        setPasteText("");
    };

    if (
        current.current?.contextKey !== contextKey ||
        current.current?.native !== native ||
        disabled
    ) {
        pasteTarget.current = null;
    }

    const stopRepeat = () => {
        clearTimeout(repeating.current?.timer);
        repeating.current = null;
    };

    const updateModifiers = (next) => {
        modifiers.current = next;
        setMods(next);
    };

    if (current.current?.contextKey !== contextKey || disabled || native) {
        intentVersion.current++;
        stopRepeat();
        pressed.current.clear();
        modifiers.current = emptyModifiers();
    }

    current.current = { contextKey, disabled, onKey, native };

    useLayoutEffect(() => {
        intentVersion.current++;
        updateModifiers(emptyModifiers());
        pressed.current.clear();
        stopRepeat();
        clearPaste();
    }, [contextKey, disabled, native, open]);

    useLayoutEffect(() => {
        if (pasting) {
            pasteField.current?.focus();
        }
    }, [pasting]);

    useLayoutEffect(() => {
        const reset = () => {
            intentVersion.current++;
            stopRepeat();
            pressed.current.clear();
            updateModifiers(emptyModifiers());
            clearPaste();
        };

        const controller = {
            reset,
            paste: () => {
                if (current.current.disabled || current.current.native) {
                    return;
                }

                if (pasteTarget.current === current.current.contextKey && pasteField.current) {
                    pasteField.current.focus();

                    return;
                }

                reset();
                pasteTarget.current = current.current.contextKey;
                setPasting(true);
            },
        };

        keyboardRef.current = controller;

        return () => {
            if (keyboardRef.current === controller) {
                keyboardRef.current = null;
            }
        };
    }, [keyboardRef]);

    useEffect(() => {
        const visibility = () => {
            if (document.hidden) {
                intentVersion.current++;
                stopRepeat();
                pressed.current.clear();
                updateModifiers(emptyModifiers());
            }
        };

        const blur = () => {
            intentVersion.current++;
            stopRepeat();
            pressed.current.clear();
            updateModifiers(emptyModifiers());
        };

        document.addEventListener("visibilitychange", visibility);
        window.addEventListener("blur", blur);

        return () => {
            intentVersion.current++;
            pressed.current.clear();
            stopRepeat();
            document.removeEventListener("visibilitychange", visibility);
            window.removeEventListener("blur", blur);
        };
    }, []);

    const stroke = (value, repeat = false, captured = modifiers.current) => ({
        key: value === "Space" ? " " : value,
        shiftKey: captured.shiftKey > 0,
        ctrlKey: captured.ctrlKey > 0,
        altKey: captured.altKey > 0,
        metaKey: captured.metaKey > 0,
        repeat,
    });

    const activate = (value, pointer, identity = value) => {
        if (current.current.disabled || current.current.native) {
            return;
        }

        const captured = modifiers.current;
        const version = intentVersion.current;
        let committed = value;

        if (/^[a-z]$/.test(identity)) {
            committed = captured.shiftKey > 0 ? identity.toUpperCase() : identity;
        } else if (/^[0-9]$/.test(identity)) {
            committed = captured.shiftKey > 0 ? shiftedNumbers[Number(identity)] : identity;
        }

        current.current.onKey(stroke(committed), { pointer });

        if (intentVersion.current === version) {
            updateModifiers(
                Object.fromEntries(
                    Object.entries(captured).map(([name, state]) => [name, state === 2 ? 2 : 0]),
                ),
            );
        }

        return captured;
    };

    const toggle = (name) => {
        stopRepeat();
        updateModifiers({ ...modifiers.current, [name]: (modifiers.current[name] + 1) % 3 });
    };

    const modifierHint = (name) =>
        mods[name] === 2
            ? "Locked. Tap to release."
            : mods[name] === 1
              ? "Active for the next key. Tap again to lock."
              : "Tap for the next key. Tap twice to lock.";

    const button = ({ value, label, width = 1, ariaLabel = value }, modifier) => html`
        <button
            type="button"
            class=${modifier ? "terminal-keyboard-modifier" : "terminal-keyboard-key"}
            style=${{ flex: width }}
            disabled=${disabled}
            aria-label=${ariaLabel}
            aria-pressed=${modifier ? mods[modifier] > 0 : undefined}
            data-locked=${modifier ? mods[modifier] === 2 : undefined}
            title=${modifier ? modifierHint(modifier) : undefined}
            aria-description=${modifier ? modifierHint(modifier) : undefined}
            onPointerDown=${(event) => {
                event.preventDefault();
                stopRepeat();

                if (disabled || native || event.button !== 0 || pressed.current.size >= 16) {
                    return;
                }

                const held = {
                    identity: ariaLabel,
                    contextKey,
                    pointerId: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                    repeated: false,
                    timer: null,
                };

                pressed.current.set(event.pointerId, held);
                event.currentTarget.setPointerCapture(event.pointerId);

                if (!modifier && repeatable.has(value)) {
                    let captured = null;

                    const tick = () => {
                        if (
                            pressed.current.get(held.pointerId) !== held ||
                            repeating.current !== held ||
                            current.current.contextKey !== held.contextKey ||
                            current.current.disabled ||
                            current.current.native
                        ) {
                            stopRepeat();

                            return;
                        }

                        // A short tap sends on click. A held key starts here; a scroll cancels
                        // before sending, so swiping over a key never types or deletes text.
                        if (captured) {
                            current.current.onKey(stroke(value, true, captured), { pointer: true });
                        } else {
                            captured = activate(value, true);
                        }

                        if (
                            pressed.current.get(held.pointerId) !== held ||
                            repeating.current !== held
                        ) {
                            return;
                        }

                        held.repeated = true;
                        held.timer = setTimeout(tick, 65);
                    };

                    repeating.current = held;
                    held.timer = setTimeout(tick, 400);
                }
            }}
            onPointerMove=${(event) => {
                const held = pressed.current.get(event.pointerId);

                if (held && Math.hypot(event.clientX - held.x, event.clientY - held.y) > 8) {
                    pressed.current.delete(event.pointerId);

                    if (repeating.current === held) {
                        stopRepeat();
                    }
                }
            }}
            onPointerUp=${(event) => {
                const held = pressed.current.get(event.pointerId);

                lastReleased.current = event.pointerId;

                if (held && Math.hypot(event.clientX - held.x, event.clientY - held.y) > 8) {
                    pressed.current.delete(event.pointerId);
                }

                if (repeating.current === held) {
                    stopRepeat();
                }
            }}
            onPointerCancel=${(event) => {
                const held = pressed.current.get(event.pointerId);

                pressed.current.delete(event.pointerId);

                if (repeating.current === held) {
                    stopRepeat();
                }
            }}
            onLostPointerCapture=${(event) => {
                if (repeating.current === pressed.current.get(event.pointerId)) {
                    stopRepeat();
                }
            }}
            onClick=${(event) => {
                const pointer = !!event.pointerType || event.detail !== 0;
                // Older browsers emit MouseEvent clicks without a pointer ID.
                const id = pressed.current.has(event.pointerId)
                    ? event.pointerId
                    : lastReleased.current;
                const held = pointer ? pressed.current.get(id) : null;

                if (pointer) {
                    pressed.current.delete(id);

                    if (repeating.current === held) {
                        stopRepeat();
                    }
                } else {
                    pressed.current.clear();
                    stopRepeat();
                }

                if (
                    pointer &&
                    (!held ||
                        held.identity !== ariaLabel ||
                        held.repeated ||
                        held.contextKey !== current.current.contextKey)
                ) {
                    return;
                }

                if (modifier) {
                    toggle(modifier);
                } else {
                    activate(value, pointer, ariaLabel);
                }
            }}
        >${label}</button>`;
    const row = (keys, className = "") => html`
        <div class=${`terminal-keyboard-row ${className}`}>${keys.map((item) => button(item))}</div>`;
    const character = (value) => ({
        ...key(shift ? value.toUpperCase() : value),
        ariaLabel: value,
    });

    const changeLayout = (next) => {
        stopRepeat();
        pressed.current.clear();
        clearPaste();
        setLayout(next);
    };

    const cancelPaste = () => {
        clearPaste();
        pasteButtonRef.current?.focus();
    };

    const submitPaste = () => {
        if (disabled || pasteTarget.current !== contextKey || !pasteText) {
            return;
        }

        if (onPaste(pasteText) !== false) {
            clearPaste();
        }
    };

    return html`
        <div class="terminal-keyboard" role="group" aria-label="Touch terminal keyboard"
            hidden=${native && !controls}>
            <div class="terminal-keyboard-toolbar">
                ${
                    !native &&
                    html`
                    <div class="terminal-keyboard-layouts" role="group" aria-label="Keyboard layout">
                        ${[
                            ["letters", "Letters", "ABC"],
                            ["symbols", "Symbols", "#+="],
                            ["function", "Function keys", "F1–12"],
                        ].map(
                            ([name, label, text]) => html`
                                <button type="button" aria-label=${label} aria-pressed=${layout === name}
                                    onPointerDown=${(event) => event.preventDefault()}
                                    onClick=${() => {
                                        changeLayout(name);
                                        onOpen(true);
                                    }}>${text}</button>`,
                        )}
                    </div>
                `
                }
                ${controls}
                ${pasteAction}
            </div>
            ${
                pasting &&
                html`
                <div class="terminal-keyboard-paste">
                    <label>
                        Text to paste
                        <textarea ref=${pasteField} rows="3" value=${pasteText} disabled=${disabled}
                            spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off"
                            placeholder="Touch and hold here, then choose Paste"
                            onInput=${(event) => setPasteText(event.currentTarget.value)}
                            onKeyDown=${(event) => {
                                event.stopPropagation();

                                if (event.key === "Escape" && !event.isComposing) {
                                    event.preventDefault();
                                    cancelPaste();
                                }
                            }} />
                    </label>
                    <p>Paste text here, then send it to the pane. No extra Enter is sent.</p>
                    <div class="terminal-keyboard-row">
                        <button type="button" disabled=${disabled || !pasteText}
                            onClick=${submitPaste}>Paste into pane</button>
                        <button type="button" onClick=${cancelPaste}>Cancel paste</button>
                    </div>
                </div>`
            }
            ${
                open &&
                !native &&
                !pasting &&
                html`
                <div class="terminal-keyboard-keys">
                    ${row(utility, "terminal-keyboard-utility")}
                    ${
                        layout === "letters"
                            ? html`
                        ${row(
                            [..."1234567890"].map((value) => {
                                const display = shift ? shiftedNumbers[Number(value)] : value;

                                return { ...key(display), ariaLabel: value };
                            }),
                        )}
                        ${row([...letters[0]].map(character))}
                        ${row([...letters[1]].map(character), "terminal-keyboard-home")}
                        <div class="terminal-keyboard-row">
                            ${button(key("Shift", "Shift", 1.5), "shiftKey")}
                            ${[...letters[2]].map((value) => button(character(value)))}
                            ${button(key("Backspace", "Bksp", 1.5))}
                        </div>
                    `
                            : layout === "symbols"
                              ? html`
                        ${symbols.map((values) => row([...values].map((value) => key(value))))}
                        <div class="terminal-keyboard-row">
                            ${button(key("Shift"), "shiftKey")}
                            ${[...",.?"].map((value) => button(key(value)))}
                            ${button(key("Backspace", "Bksp", 2))}
                        </div>
                    `
                              : html`
                        ${row(Array.from({ length: 6 }, (_, i) => key(`F${i + 1}`)))}
                        ${row(Array.from({ length: 6 }, (_, i) => key(`F${i + 7}`)))}
                        ${row([key("Insert", "Ins"), key("Backspace", "Bksp")])}
                        <div class="terminal-keyboard-row">${button(key("Shift"), "shiftKey")}</div>
                    `
                    }
                    <div class="terminal-keyboard-row">
                        ${modifierKeys.map(([name, value, label]) => button(key(value, label, 1.3), name))}
                        ${button(key("Space", "space", 3))}
                        ${button(key("Enter", "Enter", 1.8))}
                    </div>
                    ${row(
                        [
                            key("ArrowLeft", "←"),
                            key("ArrowUp", "↑"),
                            key("ArrowDown", "↓"),
                            key("ArrowRight", "→"),
                        ],
                        "terminal-keyboard-arrows",
                    )}
                </div>
            `
            }
        </div>`;
}
