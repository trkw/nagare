// Prints a new VAPID key pair for Web Push.
//   bun run push:vapid
import { generateVapidKeys } from "../src/push/webpush";

const { publicKey, privateKey } = await generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log("\nPut VAPID_PUBLIC_KEY in wrangler.jsonc vars and store the private key with:");
console.log("  bunx wrangler secret put VAPID_PRIVATE_KEY");
