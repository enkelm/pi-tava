// Coop's completed-result read-mark API uses the upstream owner, even when peeks are disabled.
// Keep one clock, storage listener and visible-open subscription; both module paths share these bindings.
export { finishedUnseen as sessionResultUnread, markSeen } from "./seen.js";
