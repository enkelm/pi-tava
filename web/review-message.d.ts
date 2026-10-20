// Shared protocol types; the DOM-free implementation is consumed by the browser and Reviews.
export type ReviewMessagePart =
    { type: "text"; text: string } | { type: "code"; text: string; suggestionIndex?: number };

export declare function reviewMessageParts(markdown: string): ReviewMessagePart[];
