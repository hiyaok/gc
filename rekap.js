const TelegramBot = require('node-telegram-bot-api');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Konfigurasi Bot
const BOT_TOKEN = '7782738957:AAE1hBtX3eIEop26IU07X_YSSaK-ki2RgNA'; // Ganti dengan token bot Anda
const ADMIN_IDS = [1285724437, 5988451717]; // Ganti dengan ID admin (bisa 2 admin)

// Inisialisasi bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Storage untuk menyimpan data user
const userSessions = new Map();

// Konfigurasi Tesseract untuk multi-bahasa
const OCR_CONFIG = {
    lang: 'eng+ind+ara+chi_sim+chi_tra+jpn+kor+tha+vie+rus+spa+fra+deu+ita+por+nld+swe+nor+dan+fin+pol+ces+hun+ron+bul+hrv+est+lav+lit+slk+slv+ukr+bel+mkd+alb+tur+heb+hin+ben+tam+tel+kan+mal+guj+pan+ori+asm+nep+sin+mya+khm+lao+mon+shn+kac+kar',
    logger: m => {} // Disable logging untuk performa
};

// Struktur data session user
class UserSession {
    constructor(userId) {
        this.userId = userId;
        this.groups = [];
        this.isProcessing = false;
        this.lastPhotoTime = null;
        this.processingMessageId = null;
        this.timer = null;
    }

    addGroup(name, members) {
        this.groups.push({ name, members });
    }

    getTotalMembers() {
        return this.groups.reduce((sum, group) => sum + group.members, 0);
    }

    getMembersSum() {
        return this.groups.map(g => g.members).join(' + ') + ` = ${this.getTotalMembers()}`;
    }

    getGroupsList() {
        return this.groups
            .map((group, index) => `${index + 1}. ${group.name} - ${group.members} anggota`)
            .join('\n');
    }

    reset() {
        this.groups = [];
        this.isProcessing = false;
        this.lastPhotoTime = null;
        this.processingMessageId = null;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}

// Fungsi download foto
async function downloadPhoto(fileId) {
    try {
        const file = await bot.getFile(fileId);
        const filePath = file.file_path;
        const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
        
        const localPath = path.join(__dirname, 'temp', `${fileId}.jpg`);
        
        // Buat folder temp jika belum ada
        if (!fs.existsSync(path.join(__dirname, 'temp'))) {
            fs.mkdirSync(path.join(__dirname, 'temp'));
        }

        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(localPath);
            https.get(url, (response) => {
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve(localPath);
                });
            }).on('error', reject);
        });
    } catch (error) {
        throw new Error(`Error downloading photo: ${error.message}`);
    }
}

// Fungsi OCR untuk extract teks dari foto
async function extractTextFromImage(imagePath) {
    try {
        const { data: { text } } = await Tesseract.recognize(imagePath, OCR_CONFIG.lang, {
            logger: OCR_CONFIG.logger
        });
        return text;
    } catch (error) {
        throw new Error(`OCR Error: ${error.message}`);
    }
}

// Fungsi parsing grup info dari teks OCR
function parseGroupInfo(text) {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line);
    
    let groupName = null;
    let memberCount = null;

    // Pattern untuk mencari nama grup (biasanya angka besar di baris terpisah)
    const groupNamePattern = /^\d{2,}$/;
    
    // Pattern untuk mencari jumlah anggota dengan berbagai bahasa
    const memberPatterns = [
        /(\d+)\s*(?:anggota|members?|участник|成员|メンバー|구성원|สมาชิก|thành viên|membre|miembro|membro|lid|medlem|jäsen|член|membro|عضو|सदस्य|সদস্য|உறுப்பினர்)/i,
        /(?:anggota|members?|участник|成员|メンバー|구성원|สมาชิก|thành viên|membre|miembro|membro|lid|medlem|jäsen|член|membro|عضو|सदस्य|সদস্য|உறுப்பினர்)\s*[:\-•]?\s*(\d+)/i,
        /grup\s*[:\-•]?\s*(\d+)\s*(?:anggota|members?)/i
    ];

    // Cari nama grup
    for (const line of lines) {
        if (groupNamePattern.test(line)) {
            groupName = line;
            break;
        }
    }

    // Cari jumlah anggota
    for (const line of lines) {
        for (const pattern of memberPatterns) {
            const match = line.match(pattern);
            if (match) {
                memberCount = parseInt(match[1]);
                break;
            }
        }
        if (memberCount !== null) break;
    }

    // Fallback: cari angka yang mungkin jumlah anggota
    if (memberCount === null) {
        const numbers = text.match(/\d+/g);
        if (numbers && numbers.length > 1) {
            // Ambil angka kedua atau yang terakhir (biasanya jumlah anggota)
            memberCount = parseInt(numbers[numbers.length > 1 ? 1 : 0]);
        }
    }

    return {
        groupName: groupName || 'Unknown',
        memberCount: memberCount || 0,
        success: groupName !== null && memberCount !== null
    };
}

// Fungsi buat keyboard inline
function createKeyboard(isFinished = false) {
    if (isFinished) {
        return {
            inline_keyboard: [
                [{ text: '🔄 Mulai Lagi', callback_data: 'restart' }]
            ]
        };
    }
    return {
        inline_keyboard: [
            [{ text: '✅ Selesai', callback_data: 'finish' }],
            [{ text: '❌ Batal', callback_data: 'cancel' }]
        ]
    };
}

// Fungsi update pesan processing
async function updateProcessingMessage(chatId, messageId, groups, isProcessing = true) {
    const statusText = isProcessing ? '⏳ Memproses foto...' : '✅ Siap untuk foto berikutnya';
    const groupsList = groups.length > 0 ? groups.map((g, i) => `${i + 1}. ${g.name} - ${g.members} anggota`).join('\n') : 'Belum ada grup yang terdeteksi';
    
    const text = `🤖 **Bot Rekap Grup**\n\n${statusText}\n\n📊 **Hasil Sementara:**\n${groupsList}\n\n💡 Kirim foto grup lainnya atau klik Selesai untuk melihat total`;
    
    try {
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: createKeyboard()
        });
    } catch (error) {
        console.error('Error updating message:', error.message);
    }
}

// Fungsi proses foto batch
async function processBatchPhotos(userId, chatId) {
    const session = userSessions.get(userId);
    if (!session || session.isProcessing) return;

    session.isProcessing = true;
    
    // Kirim pesan processing
    const processingMsg = await bot.sendMessage(chatId, '🤖 **Bot Rekap Grup**\n\n⏳ Memproses foto...\n\n📊 **Hasil Sementara:**\nBelum ada grup yang terdeteksi\n\n💡 Kirim foto grup lainnya atau klik Selesai untuk melihat total', {
        parse_mode: 'Markdown',
        reply_markup: createKeyboard()
    });
    
    session.processingMessageId = processingMsg.message_id;
    
    // Update pesan setelah selesai processing
    await updateProcessingMessage(chatId, session.processingMessageId, session.groups, false);
    session.isProcessing = false;
}

// Handler untuk foto
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Cek apakah user adalah admin
    if (!ADMIN_IDS.includes(userId)) {
        await bot.sendMessage(chatId, '❌ Maaf, hanya admin yang dapat menggunakan bot ini.');
        return;
    }

    // Inisialisasi session jika belum ada
    if (!userSessions.has(userId)) {
        userSessions.set(userId, new UserSession(userId));
    }

    const session = userSessions.get(userId);
    session.lastPhotoTime = Date.now();

    // Clear timer sebelumnya
    if (session.timer) {
        clearTimeout(session.timer);
    }

    // Set timer 10 detik
    session.timer = setTimeout(async () => {
        await processBatchPhotos(userId, chatId);
    }, 10000);

    try {
        // Download dan proses foto
        const photoId = msg.photo[msg.photo.length - 1].file_id;
        const imagePath = await downloadPhoto(photoId);
        
        // Extract teks dengan OCR
        const extractedText = await extractTextFromImage(imagePath);
        
        // Parse info grup
        const groupInfo = parseGroupInfo(extractedText);
        
        if (groupInfo.success) {
            session.addGroup(groupInfo.groupName, groupInfo.memberCount);
        }

        // Hapus file temporary
        if (fs.existsSync(imagePath)) {
            fs.unlinkSync(imagePath);
        }

        // Hapus pesan foto user untuk mengurangi spam
        try {
            await bot.deleteMessage(chatId, msg.message_id);
        } catch (error) {
            console.error('Error deleting photo message:', error.message);
        }

        // Update pesan processing jika ada
        if (session.processingMessageId) {
            await updateProcessingMessage(chatId, session.processingMessageId, session.groups, true);
        }

    } catch (error) {
        console.error('Error processing photo:', error);
        await bot.sendMessage(chatId, `❌ Error memproses foto: ${error.message}`);
    }
});

// Handler untuk callback query (button)
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    // Cek apakah user adalah admin
    if (!ADMIN_IDS.includes(userId)) {
        await bot.answerCallbackQuery(query.id, { text: 'Hanya admin yang dapat menggunakan bot ini.' });
        return;
    }

    const session = userSessions.get(userId);

    switch (data) {
        case 'finish':
            if (session && session.groups.length > 0) {
                const finalText = `🎉 **Rekap Grup Selesai!**\n\n📊 **Daftar Grup:**\n${session.getGroupsList()}\n\n🧮 **Total Anggota:**\n${session.getMembersSum()}\n\n✨ Rekap berhasil diselesaikan!`;
                
                await bot.editMessageText(finalText, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: createKeyboard(true)
                });
            } else {
                await bot.answerCallbackQuery(query.id, { text: 'Belum ada grup yang terdeteksi!' });
            }
            break;

        case 'cancel':
            if (session) {
                session.reset();
            }
            await bot.editMessageText('❌ **Rekap dibatalkan**\n\nKirim foto untuk memulai rekap baru.', {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown'
            });
            break;

        case 'restart':
            if (session) {
                session.reset();
            }
            await bot.editMessageText('🔄 **Siap untuk rekap baru!**\n\nKirim foto grup untuk memulai.', {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown'
            });
            break;
    }

    await bot.answerCallbackQuery(query.id);
});

// Command /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!ADMIN_IDS.includes(userId)) {
        await bot.sendMessage(chatId, '❌ Maaf, hanya admin yang dapat menggunakan bot ini.');
        return;
    }

    const welcomeText = `🤖 **Selamat datang di Bot Rekap Grup!**

📋 **Cara Penggunaan:**
1. Kirim foto-foto info grup (bisa banyak sekaligus)
2. Bot akan menunggu 10 detik setelah foto terakhir
3. Bot akan memproses dan menampilkan hasil sementara
4. Klik **Selesai** untuk melihat total atau lanjut kirim foto lagi

✨ **Fitur:**
• Deteksi otomatis nama grup dan jumlah anggota
• Support multi-bahasa
• Proses batch foto dengan cepat
• Hasil yang rapi dan terorganisir

💡 Kirim foto pertama untuk memulai!`;

    await bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown' });
});

// Command /help
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!ADMIN_IDS.includes(userId)) {
        await bot.sendMessage(chatId, '❌ Maaf, hanya admin yang dapat menggunakan bot ini.');
        return;
    }

    const helpText = `📚 **Panduan Bot Rekap Grup**

🔧 **Commands:**
• /start - Mulai menggunakan bot
• /help - Tampilkan panduan ini
• /status - Cek status bot

📸 **Format Foto yang Didukung:**
• Screenshot info grup WhatsApp
• Screenshot halaman anggota grup
• Foto dengan teks yang jelas

⚙️ **Tips untuk Hasil Terbaik:**
• Pastikan foto jernih dan teks terlihat jelas
• Hindari foto yang blur atau gelap
• Bot akan otomatis mendeteksi setelah 10 detik tidak ada foto baru

🌍 **Bahasa yang Didukung:**
Indonesia, English, العربية, 中文, 日本語, 한국어, ไทย, Tiếng Việt, Русский, Español, Français, Deutsch, dan banyak lagi!`;

    await bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
});

// Command /status
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!ADMIN_IDS.includes(userId)) {
        await bot.sendMessage(chatId, '❌ Maaf, hanya admin yang dapat menggunakan bot ini.');
        return;
    }

    const session = userSessions.get(userId);
    
    if (session && session.groups.length > 0) {
        const statusText = `📊 **Status Rekap Grup**

🔄 Status: ${session.isProcessing ? 'Sedang memproses...' : 'Siap'}
📈 Grup terdeteksi: ${session.groups.length}
👥 Total anggota: ${session.getTotalMembers()}

📋 **Daftar Grup:**
${session.getGroupsList()}`;

        await bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
    } else {
        await bot.sendMessage(chatId, '📊 **Status:** Tidak ada rekap yang sedang berjalan.\n\nKirim foto untuk memulai rekap baru!', { parse_mode: 'Markdown' });
    }
});

// Error handler
bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Bot is shutting down...');
    bot.stopPolling();
    process.exit(0);
});

console.log('🤖 Bot Rekap Grup started successfully!');
console.log('📝 Don\'t forget to:');
console.log('1. Replace BOT_TOKEN with your actual bot token');
console.log('2. Replace ADMIN_IDS with actual admin user IDs');
console.log('3. Install required dependencies: npm install node-telegram-bot-api tesseract.js');
console.log('4. Ensure you have proper OCR language data installed');
