// Clicking the toolbar icon opens Transcripter in the side panel, so it stays open
// while you work on the page. Browsers without side panels get it as a popup instead.
function setup() {
  const usePopup = () => chrome.action.setPopup({ popup: 'panel.html?popup=1' });
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(usePopup);
  } else {
    usePopup();
  }
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  setup();
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});
chrome.runtime.onStartup.addListener(setup);
setup();
