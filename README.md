# Keepsake

A private, self-hosted chat journal. Runs entirely on your own computer —
nothing goes through anyone else's servers, and no account is needed.

There are two ways to run it:
- **Desktop app (recommended if you don't want to touch a terminal):**
  double-click an installer, and you get a real app with its own icon and
  window. See "Desktop app" below.
- **Docker (for anyone who prefers that):** the original setup, described
  further down in this file.

## Desktop app

### Getting the installer

You don't build anything yourself — GitHub does it automatically every time
this code is pushed to your repository.

1. Push this project to your GitHub repo (same drag-and-drop flow you've
   already used).
2. On GitHub, open the **Actions** tab and wait for the "Build desktop app"
   run to finish (a few minutes, shows a green checkmark when done).
3. Click into that run, scroll to **Artifacts**, and download the one for
   your operating system — `keepsake-windows-latest` or
   `keepsake-macos-latest`. It downloads as a `.zip`; open it to get the
   real installer (`.exe` or `.dmg`) inside.

### Installing it

- **Windows:** double-click the `.exe`. Windows will likely show a blue
  "Windows protected your PC" screen first — this is completely normal for
  a small independent app like this one that isn't registered with
  Microsoft. Click **More info**, then **Run anyway**.
- **Mac:** open the `.dmg` and drag Keepsake into Applications. The first
  time you open it, macOS will likely refuse and say it's from an
  "unidentified developer" — also normal and expected. Right-click the app
  → **Open** → **Open** again in the confirmation dialog. You only need to
  do this once.

### Using it

Just open the app like any other program. There's no setup step — the
first time it runs, it automatically creates a **"Keepsake Data"** folder
inside your **Documents** folder and stores everything there: your
messages, your database, and every photo/video/audio file you attach. If
you ever want to back up your data, that's the one folder to copy.

Closing the window quits the app (on Windows/Linux) the same as any other
program. On Mac, closing the window leaves it running in the dock, same as
most Mac apps — quit it from the dock or with Cmd+Q if you want it fully
closed.

## Docker

Runs entirely in Docker — nothing else needs to be installed on your
machine.

Features:
- Nested chats — file chats inside other chats like folders, drag one chat onto
  another to nest it, or drag it to the "top level" strip to pull it back out
- Pin chats to keep them at the top; everything unpinned sorts itself by whoever
  you last wrote to, like a normal messaging app
- Duplicate a whole chat (with its messages and files) in one click
- Each chat has its own name + profile picture; rename the whole app itself too
- Select any word or phrase and format just that part — bold, italic,
  strikethrough, highlight, text color, font, and size — WhatsApp-style:
  select text, click a button, pick from a popup if it needs a color/style.
  You can also just type `*bold*` or `_italic_` directly, same as WhatsApp
- Message timestamps are fully editable, any time, to any date/time
- Attach images, videos, audio, or any file — played/shown inline, with an
  optional caption you type before sending
- All files are saved to a folder **you** choose on your own computer
- All data stays local — nothing leaves your machine

**A couple of built-in rules worth knowing:**
- Chat order: pinned chats are the ones you drag to reorder; every other chat
  sorts itself automatically by its most recent message. If a chat doesn't
  seem to move when you drag it, that's why — pin it first.
- "Duplicate" makes an independent copy of a chat (new messages, new copies
  of its files) rather than a literal clipboard copy — a browser can't hand a
  whole chat to your OS clipboard. Duplicating a chat that has sub-chats
  inside it only copies that chat's own messages, not the nested ones.
- Formatting works by literal characters in the text (`*`, `_`, and a couple
  of bracket tags) — exactly like WhatsApp, which means it has the same
  quirk: typing a literal `*` or `_` on its own will be read as formatting.
  Selecting text and using the eraser button removes formatting from it.

## 1. Requirements

Just Docker (with Docker Compose, which comes bundled with Docker Desktop and
modern Docker installs — check with `docker compose version`).

## 2. Choose where your files get stored

Copy `.env.example` to `.env`:

```
cp .env.example .env
```

Then edit `.env` and set `MEDIA_PATH` to an absolute path on your computer,
for example:

```
MEDIA_PATH=/home/yourname/chat-media
```

or on Windows (Docker Desktop):

```
MEDIA_PATH=C:/Users/YourName/ChatMedia
```

Every image/video/audio/file you upload will physically live under that folder,
organized by chat. The message database (chat text, names, timestamps, styling)
lives right alongside it, in a `database` subfolder inside the same place —
so everything the app stores ends up in one folder you chose, nothing scattered
elsewhere. Back up that whole folder and you have everything.

## 3. Start it

From this folder, run:

```
docker compose up -d --build
```

The first build takes a minute or two (it compiles a small native SQLite
module inside the container). After that, starts are instant.

Open your browser to:

```
http://localhost:8080
```

## 4. Everyday use

- Click **+** in the sidebar to create a new chat.
- Click a chat to open it; click its name at the top to rename it; click the
  avatar circle to give it a picture.
- Use the toolbar above the message box to set font, size, color, bold/italic,
  the "sender" name, and the date/time the message should show as — change the
  date/time field before sending to backdate or future-date a message.
- Use the 📎 button to attach an image, video, audio clip, or any other file.
- Hover over any message to Edit or Delete it (editing lets you change the
  text, sender, timestamp, font, and color again, any time later).

## 5. Stopping / restarting

```
docker compose down       # stop
docker compose up -d      # start again (no rebuild needed)
docker compose logs -f    # view logs
```

## 6. Changing the port

Edit `docker-compose.yml` and change `"8080:3000"` to e.g. `"9000:3000"` to
serve on port 9000 instead, then `docker compose up -d --build`.

## 7. Notes on data safety

This app has no login/auth screen — anyone who can reach port 8080 on your
network can use it. It's intended for local/private use. If you want to
expose it beyond your own machine, put it behind a reverse proxy (e.g.
Caddy or Nginx) with authentication, or only access it over a VPN/Tailscale.
