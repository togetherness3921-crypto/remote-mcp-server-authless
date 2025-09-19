const fs = require('fs');
const { exec } = require('child_process');
const chokidar = require('chokidar');

console.log('[remote-mcp] 🚀 Auto-sync process started...');
console.log('💡 Tip: Press Ctrl+C to stop auto-sync');

// Ignore node_modules, .git, and other unnecessary directories
const watcher = chokidar.watch('.', {
  ignored: [
    '**/node_modules/**',
    '**/.git/**',           // Exclude ALL .git files and folders
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/coverage/**',
    '**/*.log',
    'auto-sync.js',         // Don't watch this script itself
    'start-auto-sync.bat',  // Don't watch the batch file
    'test-auto-sync.txt',   // Don't watch test files
    '**/.DS_Store',         // Mac files
    '**/Thumbs.db',         // Windows files
    '**/*.tmp',             // Temporary files
    '**/.env*'              // Environment files
  ],
  ignoreInitial: true,
  persistent: true,
  // Additional options to prevent watching git-related changes
  usePolling: false,
  atomic: true
});

let timeoutId;
let pendingChanges = false;

function autoCommitAndPush() {
  if (!pendingChanges) return;

  console.log('📝 Auto-committing changes...');

  // First, clean up any potential problematic files
  exec('git clean -fd --dry-run', (cleanError, cleanOutput) => {
    if (cleanOutput && cleanOutput.includes('nul')) {
      exec('git clean -fd', () => console.log('🧹 Cleaned up problematic files'));
    }

    // Stage all changes (but avoid problematic files)
    exec('git add --all', (error, stdout, stderr) => {
      if (error) {
        console.error('❌ Error staging files:', error.message);
        if (stderr.includes('nul')) {
          console.log('🔧 Attempting to fix nul file issue...');
          exec('rm -f nul', () => {
            console.log('🗑️ Removed problematic nul file');
            pendingChanges = false;
          });
        }
        return;
      }

      // Check if there are actually changes to commit
      exec('git diff --cached --quiet', (diffError) => {
        if (diffError) {
          // There are changes, so commit them
          const timestamp = new Date().toLocaleString();
          const commitMessage = `Auto-sync: ${timestamp}`;

          exec(`git commit -m "${commitMessage}"`, (commitError) => {
            if (commitError) {
              console.error('❌ Error committing:', commitError.message);
              pendingChanges = false;
              return;
            }

            console.log(`✅ Committed: ${commitMessage}`);

            // Check if there are database migrations to deploy
            checkAndDeployDatabase(() => {
              // Push to GitHub after database deployment
              exec('git push origin main', (pushError) => {
                if (pushError) {
                  console.error('❌ Error pushing to GitHub:', pushError.message);
                  console.log('🔄 Will retry on next change...');
                  pendingChanges = false;
                  return;
                }

                console.log('🌟 Successfully pushed to GitHub!');
                pendingChanges = false;
              });
            });
          });
        } else {
          console.log('📄 No changes to commit');
          pendingChanges = false;
        }
      });
    });
  });
}

function checkAndDeployDatabase(callback) {
  // Check if there are changes in the supabase/migrations folder
  exec('git diff HEAD~1 --name-only | grep "supabase/migrations"', (error, stdout) => {
    if (stdout.trim()) {
      console.log('🗄️ Database migrations detected, deploying to Supabase...');

      // Deploy database changes
      exec('npm run db:deploy', (dbError, dbStdout, dbStderr) => {
        if (dbError) {
          console.error('❌ Error deploying to Supabase:', dbError.message);
          if (dbStderr) console.error('DB Error details:', dbStderr);
        } else {
          console.log('✅ Database deployed to Supabase!');
          console.log('📝 Types regenerated!');
        }
        callback();
      });
    } else {
      // No database changes, proceed with GitHub push
      callback();
    }
  });
}

// Debounce function to avoid too many commits
function scheduleCommit() {
  pendingChanges = true;

  if (timeoutId) {
    clearTimeout(timeoutId);
  }

  // Wait 3 seconds after last change before committing
  timeoutId = setTimeout(autoCommitAndPush, 3000);
  console.log('⏱️  Changes detected, will auto-commit in 3 seconds...');
}

// Watch for file changes
watcher
  .on('add', (path) => {
    console.log(`📁 File added: ${path}`);
    scheduleCommit();
  })
  .on('change', (path) => {
    console.log(`📝 File changed: ${path}`);
    scheduleCommit();
  })
  .on('unlink', (path) => {
    console.log(`🗑️  File deleted: ${path}`);
    scheduleCommit();
  });

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Auto-sync stopped. Your changes are safe!');
  watcher.close();
  process.exit(0);
});
