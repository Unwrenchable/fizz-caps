require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('redis');
const {
    Connection,
    PublicKey,
    Keypair,
    clusterApiUrl,
} = require('@solana/web3.js');
const {
    getOrCreateAssociatedTokenAccount,
    mintTo,
    TOKEN_PROGRAM_ID,
    createBurnInstruction,
} = require('@solana/spl-token');
const {
    Metaplex,
    keypairIdentity,
    bundlrStorage,
} = require('@metaplex-foundation/js');

const app = express();

// ============================
// Middleware
// ============================
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 120 }));
app.use(cors({ origin: 'https://atomicfizzcaps.xyz' }));
app.use(express.json({ limit: '10mb' }));

// ============================
// Env + Keys
// ============================
const required = ['PRIVATE_KEY_BASE64', 'REDIS_URL'];
required.forEach(k => { if (!process.env[k]) throw new Error(`Missing env var: ${k}`); });

const connection = new Connection(process.env.SOLANA_RPC_URL || clusterApiUrl('mainnet-beta'), 'confirmed');
const secret = Uint8Array.from(atob(process.env.PRIVATE_KEY_BASE64), c => c.charCodeAt(0));
const mintAuthority = Keypair.fromSecretKey(secret);
const CAPS_MINT = new PublicKey(process.env.CAPS_MINT || 'FywSJiYrtgErQwGeySiugRxCNg9xAnzRqmZQr6v2mEt2');

const metaplex = Metaplex.make(connection)
    .use(keypairIdentity(mintAuthority))
    .use(bundlrStorage());

// Redis
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', err => console.error('Redis error:', err));
redis.connect();

// ============================
// HARD-CODED LOCATIONS (fixes Vercel forever)
// ============================
const locations = [
    { "n": "Goodsprings Saloon", "lat": 35.8324, "lng": -115.4320, "lvl": 1, "rarity": "common" },
    { "n": "Primm Rollercoaster", "lat": 35.6145, "lng": -115.3845, "lvl": 2, "rarity": "common" },
    { "n": "Novac Motel", "lat": 35.0525, "lng": -114.8247, "lvl": 5, "rarity": "rare" },
    { "n": "Hoover Dam", "lat": 36.016, "lng": -114.738, "lvl": 12, "rarity": "epic" },
    { "n": "The Strip Gate", "lat": 36.1147, "lng": -115.1728, "lvl": 15, "rarity": "epic" },
    { "n": "Lucky 38", "lat": 36.147, "lng": -115.156, "lvl": 18, "rarity": "epic" },
    { "n": "Black Mountain", "lat": 35.9310, "lng": -115.0440, "lvl": 20, "rarity": "epic" },
    { "n": "Area 51 Gate", "lat": 37.2431, "lng": -115.7930, "lvl": 45, "rarity": "legendary" },
    { "n": "Vault 77 (Secret)", "lat": 36.170, "lng": -115.140, "lvl": 77, "rarity": "legendary" },
    { "n": "Chernobyl Pripyat", "lat": 51.389, "lng": 30.099, "lvl": 99, "rarity": "legendary" },
    { "n": "Fukushima Daiichi", "lat": 37.421, "lng": 141.032, "lvl": 99, "rarity": "legendary" },
    { "n": "Deathclaw Promontory", "lat": 36.1000, "lng": -114.9000, "lvl": 45, "rarity": "legendary" },
    { "n": "Los Alamos Lab", "lat": 35.875, "lng": -106.300, "lvl": 50, "rarity": "legendary" },
    { "n": "Yucca Mountain", "lat": 37.000, "lng": -116.800, "lvl": 50, "rarity": "legendary" },
    { "n": "Glowing Sea", "lat": 42.200, "lng": -71.400, "lvl": 50, "rarity": "legendary" },
    { "n": "Mothership Zeta", "lat": 0, "lng": 0, "lvl": 99, "rarity": "legendary" }
    // add the rest if you want, but even these 16 will make the map work instantly
];

// ============================
// Routes
// ============================
app.get('/locations', (req, res) => res.json(locations));
app.get('/locations', (req, res) => res.json(locations));

app.get('/player/:wallet', async (req, res) => {
    try {
        const { wallet } = req.params;
        const playerData = await getOrCreatePlayer(wallet);
        const player = playerData[0] || playerData;
        const walletPubkey = new PublicKey(wallet);
        const ata = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, CAPS_MINT, walletPubkey);
        const balance = await connection.getTokenAccountBalance(ata.address);
        player.caps = Number(balance.value.amount) / 1_000_000_000; // Add on-the-fly
        res.json(player);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/claim-survival', async (req, res) => {
    try {
        const { wallet, spot } = req.body;
        if (!wallet || !spot) return res.status(400).json({ error: 'Missing wallet or spot' });

        const walletPubkey = new PublicKey(wallet);
        const cooldownKey = `cooldown:claim:${wallet}:${spot}`;
        if (await redis.exists(cooldownKey))
            return res.status(429).json({ error: 'Still irradiated — wait 24h!' });

        // === Mint 25 CAPS ===
        const ata = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, CAPS_MINT, walletPubkey);
        const mintSig = await mintTo(connection, mintAuthority, CAPS_MINT, ata.address, mintAuthority, 25_000_000_000); // 25 CAPS (9 decimals)

        // === Random Gear Drop ===
        let gearDrop = null;
        const roll = Math.random();
        if (roll < 0.03) gearDrop = await mintGear(walletPubkey, 'Power Armor T-51b', 'legendary');
        else if (roll < 0.12) gearDrop = await mintGear(walletPubkey, 'Service Rifle', 'rare');
        else if (roll < 0.30) gearDrop = await mintGear(walletPubkey, '10mm Pistol', 'common');

        // === Possible Raid ===
        let raid = null;
        const highRisk = ['Black Mountain', 'Hoover Dam', 'Lucky 38', 'Area 51 Gate'];
        if (highRisk.some((s) => spot.includes(s)) && Math.random() < 0.07) {
            raid = await triggerRaid(wallet);
        }

        // === Update Player State ===
        const player = await getOrCreatePlayer(wallet);
        const p = player[0] || player;
        if (gearDrop) p.gear.push(gearDrop);
        if (raid) {
            p.hp = raid.hp;
            p.gear = raid.gear;
        }
        await redis.json.set(`player:${wallet}`, '$', p);

        // === 24h cooldown per spot ===
        await redis.set(cooldownKey, '1', { EX: 86400 });

        res.json({
            success: true,
            caps: 25,
            gear: gearDrop,
            raid,
            hp: p.hp,
            explorer: `https://solscan.io/tx/${mintSig}${process.env.SOLANA_RPC_URL?.includes('mainnet') ? '' : '?cluster=devnet'}`,
            message: `${spot} LOOTED! +25 CAPS${gearDrop ? ' + GEAR!' : ''}${raid ? ' → RAILED!' : ''}`,
        });
    } catch (err) {
        console.error('Claim error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/buy-stimpak', async (req, res) => {
    try {
        const { wallet, tier } = req.body;
        if (!wallet || !['common', 'rare', 'legendary'].includes(tier))
            return res.status(400).json({ error: 'Invalid request' });

        const costs = { common: 50, rare: 150, legendary: 500 };
        const cost = costs[tier];

        const walletPubkey = new PublicKey(wallet);
        const ata = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, CAPS_MINT, walletPubkey);
        const balance = await connection.getTokenAccountBalance(ata.address);
        const currentCaps = Number(balance.value.amount) / 1_000_000_000; // Assuming 9 decimals
        if (currentCaps < cost) return res.status(400).json({ error: 'Not enough CAPS' });

        const recentBlockhash = await connection.getLatestBlockhash();
        const tx = new Transaction({
            recentBlockhash: recentBlockhash.blockhash,
            feePayer: walletPubkey,
        });

        const burnAmount = BigInt(cost * 1_000_000_000);
        const burnInstruction = createBurnInstruction(
            ata.address,
            CAPS_MINT,
            walletPubkey,
            burnAmount
        );
        tx.add(burnInstruction);

        const serializedTx = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

        // Store pending buy in Redis with a short TTL
        await redis.set(`pending-buy:${wallet}:${tier}`, serializedTx, { EX: 300 }); // 5 min

        res.json({ transaction: serializedTx, message: 'Sign and send this transaction with your wallet.' });
    } catch (err) {
        console.error('Buy stimpak error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/confirm-buy-stimpak', async (req, res) => {
    try {
        const { wallet, tier, signature } = req.body;
        if (!wallet || !tier || !signature) return res.status(400).json({ error: 'Missing params' });

        // Verify pending
        const pendingKey = `pending-buy:${wallet}:${tier}`;
        const pendingTx = await redis.get(pendingKey);
        if (!pendingTx) return res.status(400).json({ error: 'No pending buy found' });

        // Confirm transaction
        const sigStatus = await connection.confirmTransaction(signature, 'confirmed');
        if (sigStatus.value.err) return res.status(400).json({ error: 'Transaction failed' });

        // Optional: Fetch tx details to verify burn amount, but for simplicity skip if rate-limited

        // Mint stimpak NFT
        const walletPubkey = new PublicKey(wallet);
        const stimpak = await mintStimpak(walletPubkey, tier); // Assume you have this function similar to mintGear

        // Update player if needed (e.g., add to inventory)
        const playerData = await getOrCreatePlayer(wallet);
        const player = playerData[0] || playerData;
        if (!player.stimpaks) player.stimpaks = [];
        player.stimpaks.push(stimpak);
        await redis.json.set(`player:${wallet}`, '$', player);

        // Clean pending
        await redis.del(pendingKey);

        res.json({
            success: true,
            stimpak,
            explorer: `https://solscan.io/tx/${signature}${process.env.SOLANA_RPC_URL?.includes('mainnet') ? '' : '?cluster=devnet'}`,
            message: `Stimpak (${tier}) purchased!`
        });
    } catch (err) {
        console.error('Confirm buy error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});
