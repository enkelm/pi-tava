// Saved-tab dismissal is local navigation state shared by the header and identity entry point.
const dismissed = new Map();
const keyOf = (userId, agentId) => `pocket.pipClosedTabs.${userId}.${agentId}`;

export function closedAgentTabs(userId, agentId) {
    const key = keyOf(userId, agentId);

    if (!dismissed.has(key)) {
        let ids = [];

        try {
            const saved = JSON.parse(sessionStorage.getItem(key) ?? "[]");

            if (Array.isArray(saved)) {
                ids = saved.filter((id) => Number.isSafeInteger(id) && id > 0);
            }
        } catch {
            // Dismissal remains UI-only when browser storage is unavailable.
        }

        dismissed.set(key, new Set(ids));
    }

    return dismissed.get(key);
}

export function setClosedAgentTabs(userId, agentId, ids) {
    const key = keyOf(userId, agentId);

    dismissed.set(key, ids);

    try {
        sessionStorage.setItem(key, JSON.stringify([...ids]));
    } catch {
        // Never alter retained chat data to dismiss a tab.
    }
}
