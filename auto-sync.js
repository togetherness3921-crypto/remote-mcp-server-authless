const { exec } = require('child_process');
const chokidar = require('chokidar');

console.log('[SUB] 🚀 Auto-sync process started...');
let isSyncing = false;

// --- Core Sync Logic ---

function pullRemoteChanges() {
  if (isSyncing) return;

  exec('git status', (statusError, statusStdout) => {
    if (statusStdout.includes('rebase in progress')) {
      console.log('[SUB] ⏳ Rebase in progress. Pausing sync until complete.');
      return;
    }

    isSyncing = true;
    console.log('[SUB] 🔄 Checking for remote updates...');
    exec('git stash', (stashErr, stashOut) => {
      exec('git pull --rebase origin main', (pullError) => {
        if (pullError && !pullError.message.includes('up to date')) {
          console.error('[SUB] ❌ Error pulling:', pullError.message);
        } else if (!pullError) {
          console.log('[SUB] ✅ Remote changes pulled successfully.');
        }

        if (stashOut && !stashOut.includes('No local changes to save')) {
          exec('git stash pop', (popErr) => {
            if (popErr) {
              console.error('[SUB] ❌ CRITICAL: Stash pop failed. Please resolve manually.');
            }
            isSyncing = false;
          });
        } else {
          isSyncing = false;
        }
      });
    });
  });
}

function commitAndPush() {
  if (isSyncing) return;
  isSyncing = true;

  console.log('[SUB] 📝 Committing and pushing changes...');
  exec('git add --all && git commit -m "Auto-sync: local change" --quiet', (commitError) => {
    exec('git push origin main', (pushError) => {
      if (pushError && !pushError.message.includes('up-to-date')) {
        console.error('[SUB] ❌ Error pushing:', pushError.message);
      } else if (!pushError) {
        console.log('[SUB] 🌟 Push successful!');
      }
      isSyncing = false;
    });
  });
}

// --- Triggers ---

const watcher = chokidar.watch('.', {
  ignored: [/node_modules/, /\.git/],
  ignoreInitial: true,
});

let commitTimeout;
watcher.on('all', (event, path) => {
  console.log(`[SUB] 📝 File change detected: ${path}`);
  clearTimeout(commitTimeout);
  commitTimeout = setTimeout(commitAndPush, 3000);
});

setInterval(pullRemoteChanges, 15000);
pullRemoteChanges(); // Initial check

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
  console.log('\n[SUB] 👋 Auto-sync stopped.');
  watcher.close();
  process.exit(0);
});
