const mineflayer = require('mineflayer');
const Movements = require('mineflayer-pathfinder').Movements;
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const { GoalBlock } = require('mineflayer-pathfinder').goals;
const config = require('./settings.json');
const express = require('express');
const readline = require('readline');

const app = express();
app.use(express.json());
let chatMessages = [];

// Store last 100 messages
function addChatMessage(msg) {
    chatMessages.push(msg);
    if (chatMessages.length > 100) chatMessages.shift();
}

app.get('/', (req, res) => {
    res.send(`
        <h1>Minecraft Bot Control</h1>
        <div style="margin-bottom: 20px;">
            <div id="statusBox" style="padding: 10px; background: #f0f0f0; border-radius: 5px;">
                Health: <span id="health">--</span>/20
                Hunger: <span id="hunger">--</span>/20
            </div>
        </div>
        <div style="margin-bottom: 20px;">
            <input type="text" id="chatInput" placeholder="Type message...">
            <button onclick="sendChat()">Send</button>
        </div>
        <div id="chatBox" style="height: 300px; border: 1px solid #ccc; overflow-y: scroll; padding: 10px; margin-bottom: 20px;"></div>
        <script>

            function sendChat() {
                const msg = document.getElementById('chatInput').value;
                fetch('/send-chat', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({message: msg})
                });
                document.getElementById('chatInput').value = '';
            }

            setInterval(() => {
                fetch('/get-chat')
                    .then(res => res.json())
                    .then(data => {
                        document.getElementById('chatBox').innerHTML = data.messages.join('<br>');
                        document.getElementById('health').textContent = Math.round(data.health);
                        document.getElementById('hunger').textContent = Math.round(data.hunger);
                        const chatBox = document.getElementById('chatBox');
                        chatBox.scrollTop = chatBox.scrollHeight;
                    });
            }, 1000);
        </script>
    `);
});


app.get('/get-chat', (req, res) => {
    res.json({ 
        messages: chatMessages,
        health: bot ? bot.health : 0,
        hunger: bot ? bot.food : 0
    });
});

app.post('/send-chat', (req, res) => {
    const message = req.body.message;
    if (bot && message) {
        bot.chat(message);
    }
    res.json({ success: true });
});


const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function createBot() {
    const fs = require('fs');
    let proxyConfig = null;

    try {
        const proxyData = fs.readFileSync('proxy.txt', 'utf8').trim();
        if (proxyData) {
            const [host, port, username, password] = proxyData.split(':');
            if (host && port) {
                proxyConfig = {
                    host: host,
                    port: parseInt(port),
                    type: 'http',
                    connect: {
                        timeout: 60000
                    },
                    clientProperties: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept-Language': 'en-US,en;q=0.9'
                    },
                    keepAlive: true,
                    keepAliveDelay: 5000
                };
                console.log('Enhanced SOCKS5 proxy configuration loaded');
            }
        }
    } catch (err) {
        console.log('No proxy configuration found');
    }

    const options = {
        username: config['bot-account']['username'],
        auth: config['bot-account']['auth'],
        host: config.server.ip,
        version: config.server.version,
        ...(proxyConfig && { proxy: proxyConfig }),
        clientProperties: {
            brand: 'vanilla',
            protocol: 'mineflayer'
        },
        hideErrors: false
    };

    const bot = mineflayer.createBot(options);

    bot.loadPlugin(pathfinder);
    const mcData = require('minecraft-data')(bot.version);
    const defaultMove = new Movements(bot, mcData);

    // Auto eat feature
    let eating = false;
    setInterval(async () => {
        if (!eating && bot.food < 15) {
            eating = true;
            const foods = bot.inventory.items().filter(item => {
                const foodName = mcData.items[item.type].name;
                return mcData.foodsArray.some(food => food.name === foodName);
            });

            if (foods.length > 0) {
                try {
                    await bot.equip(foods[0], 'hand');
                    await bot.consume();
                    await equipBestSword(); // Switch back to sword after eating
                } catch (err) {
                    console.log("Couldn't eat:", err.message);
                }
            }
            eating = false;
        }
    }, 2000);

    async function equipBestSword() {
        try {
            const materials = ['netherite', 'diamond', 'iron', 'stone', 'wooden'];
            const currentItem = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];

            const weapons = bot.inventory.items().filter(item => 
                item.name.includes('sword') || item.name.includes('axe')
            );

            if (weapons.length > 0) {
                const bestWeapon = weapons.sort((a, b) => {
                    const aMaterial = materials.find(m => a.name.includes(m)) || 'wooden';
                    const bMaterial = materials.find(m => b.name.includes(m)) || 'wooden';
                    return materials.indexOf(aMaterial) - materials.indexOf(bMaterial);
                })[0];

                const shouldEquip = !currentItem || 
                    (!currentItem.name.includes('sword') && !currentItem.name.includes('axe')) ||
                    (materials.indexOf(bestWeapon.name.split('_')[0]) < materials.indexOf(currentItem.name.split('_')[0]));

                if (shouldEquip) {
                    await bot.equip(bestWeapon, 'hand');
                    console.log(`[Combat] Equipped ${bestWeapon.name}`);
                }
            }
        } catch (err) {
            console.log('[Combat] Error equipping weapon:', err.message);
        }
    }

    setInterval(async () => {
        try {
            if (!eating && bot.health > 0) {
                await equipBestSword();
                const entity = bot.nearestEntity(e => {
                    return e.displayName && 
                           !e.displayName.toLowerCase().includes('player') &&
                           config.combat.priorityTargets.some(target => 
                               e.displayName.toLowerCase().includes(target.toLowerCase())
                           );
                });
                if (entity) {
                    try {
                        const head = entity.position.offset(0, entity.height * 0.9, 0);
                        await bot.lookAt(head);
                        if (bot.entity.position.distanceTo(entity.position) <= config.combat.range) {
                            await bot.attack(entity, true);
                            // Perform critical hit by jumping
                            if (Math.random() < 0.3) {
                                bot.setControlState('jump', true);
                                setTimeout(() => bot.setControlState('jump', false), 100);
                            }
                        }
                        
                        // Improved chase logic
                        const dist = entity.position.distanceTo(bot.entity.position);
                        if (dist > 2 && dist < 20) {
                            bot.setControlState('sprint', true);
                            bot.setControlState('forward', true);
                            setTimeout(() => {
                                bot.setControlState('sprint', false);
                                bot.setControlState('forward', false);
                            }, 150);
                        }
                    } catch (attackErr) {
                        console.log('[Combat] Attack error:', attackErr.message);
                        bot.setControlState('forward', false);
                        bot.setControlState('sprint', false);
                    }
                }
            }
        } catch (err) {
            console.log('[Combat] Error:', err.message);
        }
    }, 1000);

    const hostileMobs = [
                'Zombie', 'Skeleton', 'Spider', 'Creeper', 
                'Slime', 'Witch', 'Enderman', 'Cave Spider',
                'Zombified Piglin', 'Blaze', 'Magma Cube',
                'Drowned', 'Husk', 'Stray', 'Phantom'
            ];

    bot.once('spawn', () => {
        console.log('\x1b[33m[AfkBot] Bot joined to the server', '\x1b[0m');

        if (config.utils['auto-auth'].enabled) {
            console.log('[INFO] Started auto-auth module');

            var password = config.utils['auto-auth'].password;
            setTimeout(() => {
                bot.chat(`/register ${password} ${password}`);
                bot.chat(`/login ${password}`);
            }, 500);

            console.log(`[Auth] Authentification commands executed.`);
        }

        if (config.utils['chat-messages'].enabled) {
            console.log('[INFO] Started chat-messages module');
            var messages = config.utils['chat-messages']['messages'];

            if (config.utils['chat-messages'].repeat) {
                var delay = config.utils['chat-messages']['repeat-delay'];
                let i = 0;

                let msg_timer = setInterval(() => {
                    bot.chat(`${messages[i]}`);

                    if (i + 1 == messages.length) {
                        i = 0;
                    } else i++;
                }, delay * 1000);
            } else {
                messages.forEach((msg) => {
                    bot.chat(msg);
                });
            }
        }

        const pos = config.position;
        if (config.position.enabled) {
            console.log(
                `\x1b[32m[Afk Bot] Starting moving to target location (${pos.x}, ${pos.y}, ${pos.z})\x1b[0m`
            );
            bot.pathfinder.setMovements(defaultMove);
            bot.pathfinder.setGoal(new GoalBlock(pos.x, pos.y, pos.z));
        }

        if (config.utils['anti-afk'].enabled) {
            let moving = false;
            setInterval(() => {
                if (!moving) {
                    bot.setControlState('forward', true);
                    bot.setControlState('sprint', true);
                    setTimeout(() => {
                        bot.setControlState('forward', false);
                        bot.setControlState('sprint', false);
                        bot.setControlState('back', true);
                        setTimeout(() => {
                            bot.setControlState('back', false);
                            if (Math.random() > 0.5) bot.setControlState('jump', true);
                            setTimeout(() => bot.setControlState('jump', false), 200);
                        }, 500);
                    }, 500);
                }
            }, 2000);
        }

        rl.on('line', (line) => {
            if (line === 'exit') {
                rl.close();
                bot.quit();
            } else {
                bot.chat(line);
            }
        });
    });

    bot.on('chat', (username, message) => {
        const chatMessage = `<${username}> ${message}`;
        if (config.utils['chat-log']) {
            console.log(`[ChatLog] ${chatMessage}`);
        }
        addChatMessage(chatMessage);
    });

    bot.on('goal_reached', () => {
        console.log(
            `\x1b[32m[AfkBot] Bot arrived to target location. ${bot.entity.position}\x1b[0m`
        );
    });

    bot.on('death', () => {
        console.log(
            `\x1b[33m[AfkBot] Bot has been died and was respawned ${bot.entity.position}`,
            '\x1b[0m'
        );
    });

    if (config.utils['auto-reconnect']) {
        bot.on('end', () => {
            setTimeout(() => {
                createBot();
            }, config.utils['auto-recconect-delay']);
        });
    }

    bot.on('kicked', (reason) =>
        console.log(
            '\x1b[33m',
            `[AfkBot] Bot was kicked from the server. Reason: \n${reason}`,
            '\x1b[0m'
        )
    );

    bot.on('error', (err) =>
        console.log(`\x1b[31m[ERROR] ${err.message}`, '\x1b[0m')
    );
    return bot;
}

let bot = createBot();

app.listen(3000, '0.0.0.0', () => {
    console.log('Web interface started on port 3000');
});