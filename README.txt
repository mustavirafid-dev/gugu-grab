GUGU GRAB
=========
One-click MP3 / MP4 downloads for YouTube and Shorts.

Adds two buttons to every YouTube video: MP3 and MP4. Click one, the file
saves to the folder you choose. That's it.


WHAT YOU NEED
-------------
Windows 10 or 11, and Google Chrome (or Edge).

Python and ffmpeg are needed too, but setup.bat checks for them and tells
you exactly what to install if anything is missing.


INSTALL - 3 STEPS
-----------------
1. Double-click  setup.bat
   It finds Python, installs the downloader, and asks if you want it to
   start with Windows. Say yes.

2. A browser tab opens asking where to save your downloads.
   Pick a folder (or type any path) and click Save. Done - close the tab.

3. setup.bat prints the path to the "extension" folder. Load it:
      - open  chrome://extensions
      - turn on "Developer mode" (top right)
      - click "Load unpacked"
      - select the "extension" folder inside this one

Now open any YouTube video. The MP3 and MP4 buttons are next to Share.


DAILY USE
---------
Just click the button. Files land in the folder you picked.

You can change the folder any time:
      http://127.0.0.1:8765/setup

If the buttons say "helper not running", the background helper stopped.
Double-click start-helper.bat to bring it back.


IF SOMETHING GOES WRONG
-----------------------
Run start-helper.bat instead of relying on autostart. It keeps a window open
showing exactly what is happening - every save prints a SAVED block with the
file name and size.

To see browser-side messages: press F12 on a YouTube tab, open Console, and
look for lines starting with [Gugu].


UNINSTALL
---------
1. Double-click  uninstall.bat
2. Remove the extension from chrome://extensions
3. Delete this folder

Your downloaded files are never touched.


NOTES
-----
- This runs entirely on your own machine. Nothing is uploaded anywhere.
- The helper listens only on 127.0.0.1 (localhost) and only accepts requests
  from the browser extension, so no website can reach it.
- Only download things you have the right to download.
