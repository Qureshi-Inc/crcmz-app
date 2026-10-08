---
name: crcmz-deploy
description: Deploy the latest main branch to production (app.crcmz.me). Run this after pushing web changes. A git push alone deploys nothing — Coolify must be triggered explicitly.
---

# CRCMZ Web Deploy

Push alone does **nothing** on this repo. After every `git push`, you must queue a Coolify deploy.

## Steps (always in this order)

1. Pull with rebase (another AI also pushes here):
   ```
   git pull --rebase
   ```

2. Push your changes:
   ```
   git push
   ```

3. Trigger Coolify app 24 (one deploy at a time — never queue two):
   ```
   docker exec coolify php artisan tinker --execute='$a=App\Models\Application::find(24); $u=(string) new Visus\Cuid2\Cuid2(); queue_application_deployment(application:$a, deployment_uuid:$u, commit:"HEAD", is_api:true); echo $u;'
   ```
   The command prints a deployment UUID — save it for verification.

4. Verify the deploy landed:
   ```
   curl -s http://127.0.0.1:3021/health
   ```
   Check that `SOURCE_COMMIT` in the response matches the HEAD commit hash.

## Failure modes

- **Overlapping deploys / cancelled mid-deploy**: can leave zero containers running and the site goes down. Always let the previous deploy finish before queuing another. If the site is down after a deploy, check the Coolify UI for the failure reason.
- **Never force-push**: another AI agent also pushes to main. Use `--rebase` only.
- **Never trigger two concurrent deploys**: Coolify queues them but a mid-flight cancel kills the container.
