// Sets the saved theme before the first paint, so a light or high-contrast page never flashes dark.
// It is a separate same-origin file because the page's policy only allows scripts from this site.
(function () {
  try {
    var colors = { eclipse: "#0a0e15", light: "#f5f7fb", oled: "#000000", contrast: "#000000" };
    var t = localStorage.getItem("titan-runner:theme");
    if (!Object.prototype.hasOwnProperty.call(colors, t)) t = "eclipse";
    document.documentElement.setAttribute("data-theme", t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", colors[t]);
  } catch (e) {
    /* storage blocked: the default theme stays */
  }
})();
