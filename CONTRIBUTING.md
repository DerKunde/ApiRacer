# Contributing to ApiRacer

Thanks for helping! This guide walks you through your first pull request, even if you have never contributed to someone else's repository.

## Clone, fork, pull request

- **Clone:** a copy of a repository on your computer. You can change everything locally, but you can't push to this repository, only its owner can.
- **Fork:** your own copy of the repository on GitHub, under your account. You can push to it.
- **Pull request (PR):** asks to take the changes from a branch of your fork into this repository. The owner reviews them and merges them.

So the way is: fork on GitHub → clone your fork → branch → commits → push to your fork → pull request.

## 1. Pick an issue

Look at the issues labeled [good first issue](https://github.com/DerKunde/ApiRacer/labels/good%20first%20issue). Comment on the one you want to work on (e.g. "I'd like to take this"), so nobody else does the same. The issue is then assigned to you. Ask your questions there too, the open questions in an issue are meant to be clarified with the owner.

## 2. Fork and clone

1. On [github.com/DerKunde/ApiRacer](https://github.com/DerKunde/ApiRacer), click **Fork** at the top right, then **Create fork**.
2. Clone **your fork**, not this repository:

   ```bash
   git clone https://github.com/<your-username>/ApiRacer.git
   cd ApiRacer
   ```

3. Add this repository as `upstream`, so you can fetch new changes later:

   ```bash
   git remote add upstream https://github.com/DerKunde/ApiRacer.git
   ```

## 3. Run the project

You need [Node.js](https://nodejs.org/) 22.12 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:5173/host.html`. **No phone needed:** wait until the room code shows, then click **+ Test-Spieler** and drive with WASD. Each further click adds a player, with two or more the view splits. (Clicking before the room code shows breaks the host, see #5.)

To test with a real phone, see [Run it locally](README.md#run-it-locally) in the README.

## 4. Create a branch

```bash
git switch -c fullscreen-button
```

Use one branch per issue and name it after the change. Don't work on `main`.

## 5. Change, check, commit

Make small commits that each do one thing, with a message that says what changes, e.g. `Add a fullscreen button to the host page`.

```bash
git add <changed files>
git commit -m "Add a fullscreen button to the host page"
```

Before you push, check that everything still builds and the tests pass:

```bash
npm run build   # type check and build
npm test        # unit and server tests
```

## 6. Push and open the pull request

```bash
git push -u origin fullscreen-button
```

GitHub then shows a **Compare & pull request** button on your fork. Check that it goes from your branch into **DerKunde/ApiRacer**, branch `main`.

In the description, write:

- **What** changes and **why**
- **How to test** it, step by step
- `Closes #28` with the number of your issue: GitHub links the issue and closes it when the PR is merged
- **Open points:** what you are unsure about or left out

## 7. Checks and review

- For your first PR, the automatic checks (type check, build, tests) only start after the owner approves them. That is normal, GitHub does it for everyone who hasn't contributed yet.
- The owner reviews your PR and may ask for changes. Answer every comment: change the code, or explain why you would keep it.
- For changes, commit and push to the **same branch** again. The PR updates itself, don't open a new one.

## Keep your fork up to date

If `main` has changed in the meantime, bring the changes into your branch:

```bash
git fetch upstream
git merge upstream/main
git push
```

## Please don't

- Change the connection code (`server/`, `rtc.ts`, `signaling.ts`, `session.ts`) or the workflows in `.github/` without asking in an issue first.
- Commit `node_modules/` or `dist/`. Git already ignores them.
