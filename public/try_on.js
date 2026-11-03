// "Try on in Fitroom": run on a shop's product page as a bookmarklet, it opens Fitroom and hands it this page
// as this browser shows it (its sizes, size chart and photos, filled in by the shop's scripts), for shops that
// turn apps away. Nothing but this one page is sent, and only when the person clicks it.
//
// The bookmarklet carries this code itself (a shop's page may not let it load a script from elsewhere), with
// FITROOM set to Fitroom's address:
//   javascript:(()=>{ ...this file, minified... })()
(() => {
  const FITROOM = window.FITROOM_ORIGIN ?? "http://localhost:3000"
  // The page as shown, less what isn't the product's: scripts other than its structured data, styles, inline
  // drawings. A few hundred KB rather than a megabyte or two.
  const copy = document.documentElement.cloneNode(true)
  copy.querySelectorAll('script:not([type="application/ld+json"]), style, noscript, svg, iframe, link[rel="stylesheet"]').forEach(node => node.remove())
  const page = { type: "fitroom-page", url: location.href, html: copy.outerHTML }
  const fitroom = window.open(`${FITROOM}/?receive=1`, "fitroom")
  const send = event => {
    if (event.origin !== FITROOM || event.data?.type !== "fitroom-ready") return
    window.removeEventListener("message", send)
    fitroom.postMessage(page, FITROOM)
  }
  window.addEventListener("message", send)
})()
