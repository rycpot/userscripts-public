# Userscripts

Click an **Install** button below. If you have [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/) installed, it opens the install prompt automatically. If you don't have a userscript manager yet, install one first, then click Install again.

Updates are automatic: your userscript manager checks this repo and installs a new version when the script's `@version` changes. You can also click the same button again to update right away.

---
<h2>Reddit Unread Comment Highlighter</h2>
<p>Highlights comments posted since your last visit to a Reddit thread.</p>

<p>
  <a href="https://raw.githubusercontent.com/rycpot/userscripts-public/main/reddit-unread-comment-highlighter.user.js">
    <img src="https://img.shields.io/badge/Install-Userscript-4CAF50?style=for-the-badge&logo=tampermonkey&logoColor=white" alt="Install Reddit Unread Comment Highlighter">
  </a>
</p>
<p>
  <img src="https://files.catbox.moe/fonaku.jpeg" alt="Reddit Unread Comment Highlighter" width="600">
</p>

<h2>Instagram Right-Click Images</h2>
<p>Brings back right-click "Copy image" and "Save image as" on Instagram images.</p>

<p>
  <a href="https://raw.githubusercontent.com/rycpot/userscripts-public/main/instagram-right-click-images.user.js">
    <img src="https://img.shields.io/badge/Install-Userscript-4CAF50?style=for-the-badge&logo=tampermonkey&logoColor=white" alt="Install Instagram Right-Click Images">
  </a>
</p>
<p>
  <img src="https://rycpot.x02.me/i/7u7pIO.png" alt="Instagram Right-Click Images" width="600">
</p>

<h2>YouTube Focus Mode + Full-Sized Theater Mode</h2>
<p>Adds a Focus button that dims everything but the video, and opens videos in a full-sized Theater mode. Also:</p>
<ul>
  <li>Uses MP4/H.264 instead of WebM/VP9/AV1 (up to 1080p60)</li>
  <li>Picks 1080p automatically for videos, playlists and embeds. You can still choose another quality from the gear menu for a single video.</li>
  <li>Shows a 640×360 mini player in the top-right corner when you scroll down to the comments</li>
  <li>Hides related videos</li>
  <li>Adds a screenshot button next to the Autoplay toggle</li>
  <li>Turns off Autoplay (next video)</li>
</ul>

<p>
  <a href="https://raw.githubusercontent.com/rycpot/userscripts-public/main/youtube-focus-mode.user.js">
    <img src="https://img.shields.io/badge/Install-Userscript-4CAF50?style=for-the-badge&logo=tampermonkey&logoColor=white" alt="Install YouTube Focus Mode + Full-Sized Theater Mode">
  </a>
</p>

<h2>YouTube Comment Search</h2>
<p>Adds a search box to a video's comment section. Press <b>Cmd+S</b> (Mac) or <b>Ctrl+S</b> to jump to it. Results replace the comment list until you clear the search; matches are underlined, timestamps jump the video, and reply threads expand.</p>
<ul>
  <li>Needs your own free <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com">YouTube Data API v3</a> key. The search box asks for it the first time and saves it in Tampermonkey.</li>
  <li>Search by keywords, <code>/regex/</code>, <code>:creator</code> (comments by the uploader), or <code>global: xyz</code> to search the whole channel.</li>
  <li>Type <code>/key</code> in the search box to change your API key.</li>
  <li>The box takes the place of "Add a comment"; click <b>Comment</b> in the search box to bring the comment box back.</li>
  <li>Downloaded comments are saved for the last 20 videos you searched, so a refresh only fetches new comments (full refresh every 24 hours).</li>
</ul>

<p>
  <a href="https://raw.githubusercontent.com/rycpot/userscripts-public/main/youtube-comment-search.user.js">
    <img src="https://img.shields.io/badge/Install-Userscript-4CAF50?style=for-the-badge&logo=tampermonkey&logoColor=white" alt="Install YouTube Comment Search">
  </a>
</p>
