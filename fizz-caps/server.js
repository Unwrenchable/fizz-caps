const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, mintTo, getAccount } = require('@solana/spl-token');
const { Metaplex, keypairIdentity } = require('@metaplex-foundation/js');

const app = express();
app.use(cors());
app.use(express.json());

const connection = new Connection('https://api.devnet.solana.com'); // CHANGE TO MAINNET
const CAPS_MINT = new PublicKey('FywSJiYrtgErQwGeySiugRxCNg9xAnzRqmZQr6v2mEt2'); // UPDATE
const GEAR_COLLECTION = new PublicKey('YOUR_GEAR_COLLECTION_MINT'); // CREATE THIS
const STIMPAK_COLLECTION = new PublicKey('YOUR_STIMPAK_COLLECTION_MINT');

// Load your mint authority (same keypair from devnet)
const mintAuthority = Keypair.fromSecretKey(Uint8Array.from([YOUR_PRIVATE_KEY_ARRAY]));

const metaplex = Metaplex.make(connection).use(keypairIdentity(mintAuthority));

const playerData = new Map(); // In-memory (use Redis for production)

app.post('/claim-survival', async (req, res) => {
  const { wallet, spot } = req.body;
  const walletPubkey = new PublicKey(wallet);
  
  // Mint 25 CAPS
  const ata = await getOrCreateAssociatedTokenAccount(
    connection, mintAuthority, CAPS_MINT, walletPubkey
  );
  await mintTo(connection, mintAuthority, CAPS_MINT, ata.address, mintAuthority, 25 * 10**9);
  
  // 20% chance gear drop
  let gearDrop = null;
  const roll = Math.random();
  if (roll < 0.05) gearDrop = await mintGear(walletPubkey, 'Power Armor T-51b', 'legendary');
  else if (roll < 0.20) gearDrop = await mintGear(walletPubkey, 'Service Rifle', 'rare');
  else if (roll < 0.35) gearDrop = await mintGear(walletPubkey, '10mm Pistol', 'common');
  
  // 5% chance raid at high-traffic spots
  let raidResult = null;
  const highTrafficSpots = ['Black Mountain', 'Hoover Dam', 'Lucky 38'];
  if (highTrafficSpots.includes(spot) && Math.random() < 0.05) {
    raidResult = await triggerRaid(walletPubkey);
  }
  
  // Update player state
  const player = getOrCreatePlayer(walletPubkey.toString());
  player.caps += 25;
  if (gearDrop) player.gear.push(gearDrop);
  if (raidResult) {
    player.hp = raidResult.hp;
    player.gear = raidResult.gear;
  }
  
  const explorer = `https://solscan.io/tx/${ata.signature}?cluster=devnet`;
  
  res.json({
    success: true,
    caps: 25,
    gear: gearDrop,
    raid: raidResult,
    playerState: { hp: player.hp, gear: player.gear, stimpaks: player.stimpaks },
    explorer,
    message: `${spot} LOOTED!`
  });
});

app.post('/buy-stimpak', async (req, res) => {
  const { wallet, tier, cost } = req.body;
  const walletPubkey = new PublicKey(wallet);
  const player = getOrCreatePlayer(wallet);
  
  if (player.caps < cost) {
    return res.json({ success: false, error: 'Not enough CAPS' });
  }
  
  // Burn CAPS (simplified - implement proper burn)
  player.caps -= cost;
  
  // Mint Stimpak NFT
  const stimpak = await mintStimpak(walletPubkey, tier);
  player.stimpaks.push(stimpak);
  
  res.json({
    success: true,
    stimpak: `${tier === 'rare' ? 'Super ' : ''}Stimpak`,
    cooldown: tier === 'legendary' ? '7 days' : tier === 'rare' ? '12h' : '24h'
  });
});

app.get('/player/:wallet', (req, res) => {
  const player = getOrCreatePlayer(req.params.wallet);
  res.json(player);
});

// Helper functions
async function mintGear(toWallet, name, rarity) {
  const { nft } = await metaplex.nfts().create({
    uri: `https://atomicfizzcaps.xyz/nft/${rarity}/${name.toLowerCase().replace(' ', '-')}.json`,
    name: `${name} (${rarity.toUpperCase()})`,
    sellerFeeBasisPoints: 500, // 5%
    collection: GEAR_COLLECTION
  });
  
  return {
    id: nft.address.toString(),
    name,
    rarity,
    durability: 100,
    defense: rarity === 'legendary' ? 75 : rarity === 'rare' ? 30 : 10,
    attack: rarity === 'legendary' ? 40 : rarity === 'rare' ? 15 : 5
  };
}

async function mintStimpak(toWallet, tier) {
  const name = tier === 'legendary' ? 'Med-X + Stimpak' : 
               tier === 'rare' ? 'Super Stimpak' : 'Stimpak';
  
  const { nft } = await metaplex.nfts().create({
    uri: `https://atomicfizzcaps.xyz/nft/stimpak/${tier}.json`,
    name,
    sellerFeeBasisPoints: 500,
    collection: STIMPAK_COLLECTION
  });
  
  return { id: nft.address.toString(), name, tier };
}

async function triggerRaid(walletPubkey) {
  const player = getOrCreatePlayer(walletPubkey.toString());
  const enemies = [
    { name: 'Super Mutant Centurion', attack: 60, defense: 45, reward: 250 },
    { name: 'Raider Warlord', attack: 35, defense: 25, reward: 75 },
    { name: 'Deathclaw', attack: 120, defense: 90, reward: 1000 }
  ];
  const enemy = enemies[Math.floor(Math.random() * enemies.length)];
  
  // Calculate player defense with gear durability penalty
  let totalDefense = 20;
  player.gear.forEach(g => {
    const penalty = (100 - g.durability) / 100;
    totalDefense += g.defense * (1 - penalty * 0.5);
  });
  
  const damage = Math.max(0, enemy.attack - totalDefense);
  player.hp = Math.max(0, player.hp - damage);
  
  // Gear damage
  player.gear.forEach(g => {
    g.durability = Math.max(0, g.durability - 25);
  });
  
  let revived = false;
  if (player.hp <= 0 && player.stimpaks.length > 0) {
    const stimpak = player.stimpaks.shift();
    const reviveHp = stimpak.tier === 'legendary' ? 100 : 
                     stimpak.tier === 'rare' ? 75 : 50;
    player.hp = reviveHp;
    
    // Repair gear
    const repair = stimpak.tier === 'legendary' ? 1.0 : 
                   stimpak.tier === 'rare' ? 0.5 : 0.25;
    let repairedCount = 0;
    player.gear.forEach(g => {
      if (g.durability < 100) {
        g.durability = Math.min(100, g.durability + (100 * repair));
        repairedCount++;
      }
    });
    
    revived = true;
  }
  
  return {
    enemy: enemy.name,
    won: player.hp > 0 && !revived,
    revived,
    hp: player.hp,
    gear: player.gear,
    stimpakUsed: revived ? player.stimpaks[0]?.name : null,
    hpRestored: revived ? reviveHp : 0,
    gearRepaired: revived ? `${repairedCount} pieces` : 0
  };
}

function getOrCreatePlayer(wallet) {
  if (!playerData.has(wallet)) {
    playerData.set(wallet, {
      caps: 0,
      hp: 100,
      gear: [],
      stimpaks: []
    });
  }
  return playerData.get(wallet);
}

app.listen(process.env.PORT || 3000, () => {
  console.log('Atomic Fizz Survival Server Live');
});
