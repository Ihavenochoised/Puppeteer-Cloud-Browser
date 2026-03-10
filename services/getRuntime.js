export default function () {
    if (process.env.RENDER) return "render";
    if (process.env.CODESPACES) return "codespaces";
    if (process.env.REPL_ID) return "replit";
    if (process.platform === "win32") return "windows";
    return "unknown";
}