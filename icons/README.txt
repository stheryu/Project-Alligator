How to use:
1) Unzip this into your extension project, e.g. ~/Dev/Project-Alligator/icons/
   After unzipping, you should have icons/icon16.png, icons/icon24.png, ..., icons/icon512.png
2) Add to manifest.json:

  "icons": {
    "16": "icons/icon16.png",
    "24": "icons/icon24.png",
    "32": "icons/icon32.png",
    "48": "icons/icon48.png",
    "64": "icons/icon64.png",
    "128": "icons/icon128.png",
    "256": "icons/icon256.png",
    "512": "icons/icon512.png"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "24": "icons/icon24.png",
      "32": "icons/icon32.png"
    }
  }

3) In chrome://extensions, click Reload on your extension.
