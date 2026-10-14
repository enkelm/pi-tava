// Report physical viewport geometry, independently of transient frame/input availability.
// One reporter belongs to one mounted grid; observe() follows its observer lifecycle.
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function terminalViewport() {
    // Metadata gaps may recreate observers without changing physical geometry.
    // Keep this cache for the grid/connection, not for one observation period.
    let last = "";

    return {
        observe(element, { cw, ch, maxCells, read, report }) {
            let disposed = false;

            const resize = () => {
                const state = read();

                if (disposed || !state.active || !element?.clientWidth || !element.clientHeight) {
                    return;
                }

                const cols = clamp(Math.floor(element.clientWidth / cw), 1, 4096);
                const rows = clamp(
                    Math.floor(element.clientHeight / ch),
                    1,
                    Math.min(4096, Math.floor(maxCells / cols)),
                );
                const size = {
                    cols,
                    rows,
                    cell_width_px: Math.max(1, Math.round(cw)),
                    cell_height_px: Math.max(1, Math.round(ch)),
                };
                const key = JSON.stringify([state.epoch, size]);

                if (key !== last) {
                    last = key;
                    report(size);
                }
            };

            const observer =
                typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;

            observer?.observe(element);
            window.addEventListener("resize", resize);
            resize();

            return () => {
                disposed = true;
                observer?.disconnect();
                window.removeEventListener("resize", resize);
            };
        },
    };
}
