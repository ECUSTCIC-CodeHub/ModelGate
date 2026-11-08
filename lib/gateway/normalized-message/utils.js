export function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
export function asArray(value) {
    return Array.isArray(value) ? value : [];
}
