chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen" || msg.action !== "COPY") return;
  const ta = document.getElementById("t");
  ta.value = msg.text;
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (_) {}
  sendResponse({ ok });
});