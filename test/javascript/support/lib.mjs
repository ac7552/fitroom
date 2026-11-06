// Lets Node load the page's modules as the browser does: "lib/..." (the importmap's name) is
// app/javascript/lib/....js. Import this, then load those modules with a dynamic import().
import { register } from "node:module"

const root = new URL("../../../app/javascript/", import.meta.url).href
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier.startsWith("lib/")) return next(${JSON.stringify(root)} + specifier + ".js", context)
    if (specifier === "three") return next(${JSON.stringify(new URL("../../../vendor/javascript/three.js", import.meta.url).href)}, context)
    return next(specifier, context)
  }`)}`)
