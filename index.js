import { GearApi, decodeAddress } from "@gear-js/api";
import { Keyring } from "@polkadot/keyring";
import { setTimeout as wait } from "timers/promises";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

console.log("🔥 POLYBASKETS CLAIM & BET LEGITIMIZER STARTING...");

// --- CONFIG ---
const RPC = "wss://rpc.vara.network";
const BASKET_MARKET = "0xe5dd153b813c768b109094a9e2eb496c38216b1dbe868391f1d20ac927b7d2c2";
const BET_TOKEN = "0x186f6cda18fea13d9fc5969eec5a379220d6726f64c1d5f4b346e89271f917bc";
const BET_LANE = "0x35848dea0ab64f283497deaff93b12fe4d17649624b2cd5149f253ef372b29dc";

const VOUCHER_URL = "https://voucher-backend-production-5a1b.up.railway.app/voucher";
const BET_QUOTE_URL = "https://bet-quote-service-production.up.railway.app/api/bet-lane/quote";
const POLYMARKET_API = "https://gamma-api.polymarket.com/markets";

const BET_AMOUNT = "10000000000000"; // 10 CHIP
const AGENT_NAME = process.env.AGENT_NAME || "bet-legitimizer";

// --- STATE ---
let api;
let account;
let hexAddress;
let voucherId;

function log(...args) {
    console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

async function init() {
    log("🔌 Connecting to Vara...");
    api = await GearApi.create({ providerAddress: RPC });

    const keyring = new Keyring({ type: "sr25519" });
    if (!process.env.PRIVATE_KEY) {
        throw new Error("PRIVATE_KEY missing in .env");
    }
    account = keyring.addFromUri(process.env.PRIVATE_KEY);

    // Update to correct hex for the wallet running THIS server
    hexAddress = "0xa043f97bc85c4c43e67244fc6d19a7d796b88adda32c766778ceb948699c7d76";

    log("✅ Connected:", account.address);
    log("🆔 Hex Address:", hexAddress);
}

async function ensureVoucher() {
    try {
        log("🎫 Checking voucher status...");
        const res = await fetch(`${VOUCHER_URL}/${hexAddress}`);
        const data = await res.json();

        if (data.voucherId && data.canTopUpNow === false) {
            log("✅ Voucher active:", data.voucherId);
            voucherId = data.voucherId;
            return;
        }

        log("🆕 Requesting/Topping up voucher...");
        const postRes = await fetch(VOUCHER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                account: hexAddress,
                programs: [BASKET_MARKET, BET_TOKEN, BET_LANE]
            })
        });

        const postData = await postRes.json();
        if (postData.voucherId) {
            log("✅ Voucher ready:", postData.voucherId);
            voucherId = postData.voucherId;
        } else if (postRes.status === 429) {
            log("⏳ Rate limited, using existing voucher if available");
            if (data.voucherId) voucherId = data.voucherId;
        }
    } catch (err) {
        log("⚠️ Voucher error:", err.message);
    }
}

async function registerAgent() {
    if (!voucherId) return false;

    try {
        const { promisify } = await import("node:util");
        const { execFile } = await import("node:child_process");
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");

        const execFileAsync = promisify(execFile);
        const home = process.env.HOME || process.env.USERPROFILE || "";

        const idlCandidates = [
            process.env.POLYBASKETS_IDL,
            process.env.POLYBASKETS_SKILLS_DIR
                ? join(process.env.POLYBASKETS_SKILLS_DIR, "idl", "polymarket-mirror.idl")
                : null,
            join(process.cwd(), "skills", "idl", "polymarket-mirror.idl"),
            join(home, ".agents", "skills", "polybaskets-skills", "idl", "polymarket-mirror.idl")
        ].filter(Boolean);

        const idlPath = idlCandidates.find((p) => existsSync(p));

        if (!idlPath) {
            log("❌ Register error: polymarket-mirror.idl not found");
            return false;
        }

        const signerArgs = process.env.PRIVATE_KEY.trim().includes(" ")
            ? ["--mnemonic", process.env.PRIVATE_KEY.trim()]
            : ["--seed", process.env.PRIVATE_KEY.trim()];

        const argsJson = JSON.stringify([AGENT_NAME]);

        await execFileAsync("vara-wallet", ["config", "set", "network", "mainnet"], {
            maxBuffer: 1024 * 1024,
            timeout: 60000
        });

        log("📝 Registering agent name on-chain...");

        const { stdout, stderr } = await execFileAsync(
            "vara-wallet",
            [
                ...signerArgs,
                "call",
                BASKET_MARKET,
                "BasketMarket/RegisterAgent",
                "--args",
                argsJson,
                "--voucher",
                voucherId,
                "--gas-limit",
                "15000000000",
                "--idl",
                idlPath
            ],
            { maxBuffer: 1024 * 1024 * 4, timeout: 120000 }
        );

        log("✅ Registration submitted");
        return true;
    } catch (err) {
        log("ℹ️ Registration note:", String(err));
        return false;
    }
}

async function claimCHIP() {
    if (!voucherId) return false;

    try {
        const { promisify } = await import("node:util");
        const { execFile } = await import("node:child_process");
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");

        const execFileAsync = promisify(execFile);
        const home = process.env.HOME || process.env.USERPROFILE || "";

        const idlCandidates = [
            process.env.BET_TOKEN_IDL,
            process.env.POLYBASKETS_SKILLS_DIR
                ? join(process.env.POLYBASKETS_SKILLS_DIR, "idl", "bet_token_client.idl")
                : null,
            join(process.cwd(), "skills", "idl", "bet_token_client.idl"),
            join(home, ".agents", "skills", "polybaskets-skills", "idl", "bet_token_client.idl")
        ].filter(Boolean);

        const idlPath = idlCandidates.find((p) => existsSync(p));

        if (!idlPath) return false;

        const signerArgs = process.env.PRIVATE_KEY.trim().includes(" ")
            ? ["--mnemonic", process.env.PRIVATE_KEY.trim()]
            : ["--seed", process.env.PRIVATE_KEY.trim()];

        log("🪙 Attempting to Claim hourly CHIP...");

        await execFileAsync("vara-wallet", ["config", "set", "network", "mainnet"], { maxBuffer: 1024 * 1024, timeout: 60000 });

        const { stdout, stderr } = await execFileAsync(
            "vara-wallet",
            [
                ...signerArgs,
                "call",
                BET_TOKEN,
                "BetToken/Claim",
                "--args",
                "[]",
                "--voucher",
                voucherId,
                "--gas-limit",
                "25000000000",
                "--idl",
                idlPath
            ],
            { maxBuffer: 1024 * 1024 * 4, timeout: 120000 }
        );

        const raw = stdout.trim();
        let parsed = null;

        try { parsed = JSON.parse(raw); } catch { return false; }

        if (parsed?.result === false) {
            log("ℹ️ Claim not available yet");
            return false;
        }

        log("✅ CHIP Claimed");
        return true;
    } catch (err) {
        const detail = err?.stderr?.trim?.() || err?.stdout?.trim?.() || String(err);
        if (detail.includes("ClaimTooEarly") || detail.includes("ClaimNotAvailable")) {
            log("ℹ️ Claim not available yet");
            return false;
        }
        return false;
    }
}

async function fetchMarkets() {
    try {
        const now = new Date();
        const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);
        const res = await fetch(`${POLYMARKET_API}?closed=false&order=volume24hr&ascending=false&end_date_min=${oneHourLater.toISOString()}&limit=10`);

        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const markets = await res.json();

        return markets.map(m => ({
            poly_market_id: String(m.id),
            poly_slug: m.slug,
            question: m.question,
            outcomePrices: m.outcomePrices ? JSON.parse(m.outcomePrices) : []
        })).filter(m => m.outcomePrices && m.outcomePrices.length >= 2);
    } catch (err) {
        return [];
    }
}

async function createAutonomousBasket() {
    if (!voucherId) return null;

    try {
        const { promisify } = await import("node:util");
        const { execFile } = await import("node:child_process");
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");

        const execFileAsync = promisify(execFile);

        const markets = await fetchMarkets();
        if (markets.length < 2) return null;

        const selected = [];
        const usedIndices = new Set();
        while (selected.length < 2) {
            const idx = Math.floor(Math.random() * markets.length);
            if (!usedIndices.has(idx)) {
                selected.push(markets[idx]);
                usedIndices.add(idx);
            }
        }

        const items = selected.map(m => ({
            poly_market_id: String(m.poly_market_id),
            poly_slug: String(m.poly_slug).slice(0, 128),
            weight_bps: 5000,
            selected_outcome: Math.random() > 0.5 ? "YES" : "NO"
        }));

        const basketName = `Bet-${AGENT_NAME}-${Math.random().toString(36).substring(2, 7)}`.slice(0, 128);
        const description = "Basket for legitimizing bet profile".slice(0, 512);
        const home = process.env.HOME || process.env.USERPROFILE || "";

        const idlCandidates = [
            process.env.POLYBASKETS_IDL,
            process.env.POLYBASKETS_SKILLS_DIR ? join(process.env.POLYBASKETS_SKILLS_DIR, "idl", "polymarket-mirror.idl") : null,
            join(process.cwd(), "skills", "idl", "polymarket-mirror.idl"),
            join(home, ".agents", "skills", "polybaskets-skills", "idl", "polymarket-mirror.idl")
        ].filter(Boolean);

        const idlPath = idlCandidates.find((p) => existsSync(p));
        if (!idlPath || !process.env.PRIVATE_KEY) return null;

        const signerArgs = process.env.PRIVATE_KEY.trim().includes(" ")
            ? ["--mnemonic", process.env.PRIVATE_KEY.trim()]
            : ["--seed", process.env.PRIVATE_KEY.trim()];

        const argsJson = JSON.stringify([basketName, description, items, "Bet"]);

        await execFileAsync("vara-wallet", ["config", "set", "network", "mainnet"], { maxBuffer: 1024 * 1024, timeout: 60000 });

        const { stdout } = await execFileAsync(
            "vara-wallet",
            [ ...signerArgs, "call", BASKET_MARKET, "BasketMarket/CreateBasket", "--voucher", voucherId, "--args", argsJson, "--gas-limit", "35000000000", "--idl", idlPath ],
            { maxBuffer: 1024 * 1024 * 4, timeout: 120000 }
        );

        const raw = stdout.trim();
        let basketId = null;

        try {
            const parsed = JSON.parse(raw);
            basketId = parsed?.result ?? parsed?.ok ?? parsed;
        } catch {
            const match = raw.match(/\d+/g);
            if (match && match.length) basketId = match[match.length - 1];
        }

        if (basketId) {
            basketId = String(basketId);
            log(`🎯 Basket created for Bet processing. ID: ${basketId}`);
            return basketId;
        }
        return null;
    } catch (err) {
        return null;
    }
}

async function getQuote(basketId) {
    try {
        const numericBasketId = Number(basketId);
        await wait(2000);

        const body = { user: hexAddress, basketId: numericBasketId, amount: BET_AMOUNT, targetProgramId: BET_LANE };
        const res = await fetch(BET_QUOTE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok || !data || data.error) return null;
        return data;
    } catch {
        return null;
    }
}

async function approveBetLane(amount) {
    if (!voucherId) return false;
    try {
        const { promisify } = await import("node:util");
        const { execFile } = await import("node:child_process");
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");

        const execFileAsync = promisify(execFile);
        const home = process.env.HOME || process.env.USERPROFILE || "";

        const idlCandidates = [
            process.env.BET_TOKEN_IDL,
            process.env.POLYBASKETS_SKILLS_DIR ? join(process.env.POLYBASKETS_SKILLS_DIR, "idl", "bet_token_client.idl") : null,
            join(process.cwd(), "skills", "idl", "bet_token_client.idl"),
            join(home, ".agents", "skills", "polybaskets-skills", "idl", "bet_token_client.idl")
        ].filter(Boolean);

        const idlPath = idlCandidates.find((p) => existsSync(p));
        if (!idlPath) return false;

        const signerArgs = process.env.PRIVATE_KEY.trim().includes(" ")
            ? ["--mnemonic", process.env.PRIVATE_KEY.trim()]
            : ["--seed", process.env.PRIVATE_KEY.trim()];

        log(`✅ Approving EXACT amount needed for Bet execution...`);

        await execFileAsync("vara-wallet", ["config", "set", "network", "mainnet"], { maxBuffer: 1024 * 1024, timeout: 60000 });
        const argsJson = `["${BET_LANE}", ${Number(amount)}]`;

        const { stdout } = await execFileAsync(
            "vara-wallet",
            [ ...signerArgs, "call", BET_TOKEN, "BetToken/Approve", "--args", argsJson, "--voucher", voucherId, "--gas-limit", "25000000000", "--idl", idlPath ],
            { maxBuffer: 1024 * 1024 * 4, timeout: 120000 }
        );

        const parsed = JSON.parse(stdout?.trim() || "{}");
        return parsed?.result === true;
    } catch {
        return false;
    }
}

async function placeBet(basketId, quote) {
    if (!voucherId) return;
    try {
        const approved = await approveBetLane(BET_AMOUNT);
        if (!approved) return;

        const { promisify } = await import("node:util");
        const { execFile } = await import("node:child_process");
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");

        const execFileAsync = promisify(execFile);
        const home = process.env.HOME || process.env.USERPROFILE || "";

        const idlCandidates = [
            process.env.BET_LANE_IDL,
            process.env.POLYBASKETS_SKILLS_DIR ? join(process.env.POLYBASKETS_SKILLS_DIR, "idl", "bet_lane_client.idl") : null,
            join(process.cwd(), "skills", "idl", "bet_lane_client.idl"),
            join(home, ".agents", "skills", "polybaskets-skills", "idl", "bet_lane_client.idl")
        ].filter(Boolean);

        const idlPath = idlCandidates.find((p) => existsSync(p));
        if (!idlPath) return;

        const signerArgs = process.env.PRIVATE_KEY.trim().includes(" ")
            ? ["--mnemonic", process.env.PRIVATE_KEY.trim()]
            : ["--seed", process.env.PRIVATE_KEY.trim()];

        log("💰 Placing bet on:", basketId);
        const argsJson = JSON.stringify([Number(basketId), BET_AMOUNT, quote]);

        await execFileAsync("vara-wallet", ["config", "set", "network", "mainnet"], { maxBuffer: 1024 * 1024, timeout: 60000 });

        const { stdout, stderr } = await execFileAsync(
            "vara-wallet",
            [ ...signerArgs, "call", BET_LANE, "BetLane/PlaceBet", "--args", argsJson, "--voucher", voucherId, "--gas-limit", "35000000000", "--idl", idlPath ],
            { maxBuffer: 1024 * 1024 * 4, timeout: 120000 }
        );

        log("✅ Bet placed successfully!");
    } catch (err) {
        log("❌ Bet error:", err.message);
    }
}

async function loop() {
    log("🚀 CLAIM & BET LEGITIMIZER LOOP STARTED");

    await init();
    await ensureVoucher();
    await registerAgent();

    while (true) {
        try {
            await ensureVoucher();
            
            // 1. Attempt to claim every single cycle (balances the books heavily if the hour rolled over)
            await claimCHIP();

            log("🔄 Processing Legitimizer Bet Cycle...");
            
            // 2. Generate a fresh basket just to bet on
            const basketId = await createAutonomousBasket();

            if (basketId) {
                const quote = await getQuote(basketId);
                if (quote) {
                    // 3. Approve exactly what is needed and Place Bet
                    await placeBet(basketId, quote);
                } else {
                    log("⚠️ Failed to grab quote, skipping bet this round.");
                }
            }

            // Zero delay to execute continuously alongside spammers
            
        } catch (err) {
            log("💥 Loop error:", err.message);
            await wait(10000);
        }
    }
}

async function main() {
    await init();
    await loop();
}

main().catch((err) => {
    console.error("💥 Fatal:", err);
    process.exit(1);
});
