const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const FormData = require('form-data');
const sharp = require('sharp');

// Konfigurasi Bot
const BOT_TOKEN = '7782738957:AAE1hBtX3eIEop26IU07X_YSSaK-ki2RgNA';
const ADMIN_IDS = [5988451717, 1285724437];

// OCR.space API (GRATIS - 25,000 requests/month)
const OCR_SPACE_API_KEY = 'helloworld'; // Free API key, atau daftar di ocr.space untuk yang lebih banyak

// Inisialisasi bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Storage untuk menyimpan data user
const userSessions = new Map();

// Struktur data session user
class UserSession {
    constructor(userId) {
        this.userId = userId;
        this.groups = [];
        this.isProcessing = false;
        this.lastPhotoTime = null;
        this.processingMessageId = null;
        this.timer = null;
        this.photoQueue = [];
    }

    addGroup(name, members) {
        // Cek duplikasi
        const exists = this.groups.find(g => g.name === name);
        if (!exists) {
            this.groups.push({ name, members });
        }
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
        this.photoQueue = [];
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}

// Fungsi preprocessing gambar untuk meningkatkan akurasi OCR
async function preprocessImage(inputPath) {
    try {
        const outputPath = inputPath.replace('.jpg', '_processed.jpg');
        
        await sharp(inputPath)
            .resize(1200, null, { 
                withoutEnlargement: false,
                fit: 'inside'
            })
            .sharpen()
            .normalize()
            .gamma(1.2)
            .jpeg({ quality: 95 })
            .toFile(outputPath);
        
        return outputPath;
    } catch (error) {
        console.error('Error preprocessing image:', error);
        return inputPath; // Return original if preprocessing fails
    }
}

// Fungsi OCR menggunakan OCR.space API (lebih akurat dan cepat)
async function ocrSpaceAPI(imagePath) {
    return new Promise((resolve, reject) => {
        const form = new FormData();
        form.append('file', fs.createReadStream(imagePath));
        form.append('apikey', OCR_SPACE_API_KEY);
        form.append('language', 'eng');
        form.append('isOverlayRequired', 'false');
        form.append('detectOrientation', 'true');
        form.append('scale', 'true');
        form.append('OCREngine', '2'); // Engine 2 is better for complex layouts

        const options = {
            hostname: 'api.ocr.space',
            port: 443,
            path: '/parse/image',
            method: 'POST',
            headers: form.getHeaders()
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.ParsedResults && result.ParsedResults[0]) {
                        resolve(result.ParsedResults[0].ParsedText);
                    } else {
                        reject(new Error('No text found'));
                    }
                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on('error', reject);
        form.pipe(req);
    });
}

// Fungsi OCR fallback menggunakan Tesseract (jika OCR.space gagal)
async function tesseractOCR(imagePath) {
    try {
        const Tesseract = require('tesseract.js');
        const { data: { text } } = await Tesseract.recognize(imagePath, 'eng+ind+ara+chi_sim+jpn+kor', {
            logger: () => {} // Silent
        });
        return text;
    } catch (error) {
        throw new Error(`Tesseract OCR failed: ${error.message}`);
    }
}

// Fungsi OCR utama dengan multiple engines
async function extractTextFromImage(imagePath) {
    try {
        // Preprocessing gambar untuk akurasi lebih baik
        const processedPath = await preprocessImage(imagePath);
        
        // Coba OCR.space API dulu (lebih akurat)
        try {
            const text = await ocrSpaceAPI(processedPath);
            console.log('✅ OCR.space success');
            return text;
        } catch (error) {
            console.log('⚠️ OCR.space failed, trying Tesseract...');
            
            // Fallback ke Tesseract
            const text = await tesseractOCR(processedPath);
            console.log('✅ Tesseract success');
            return text;
        }
    } catch (error) {
        throw new Error(`All OCR methods failed: ${error.message}`);
    }
}

// Fungsi parsing yang sangat spesifik untuk format WhatsApp grup
function parseWhatsAppGroupInfo(text) {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line);
    
    let groupName = null;
    let memberCount = null;

    console.log('🔍 Analyzing text:', lines);

    // Pattern untuk mencari jumlah anggota (lebih comprehensive)
    const memberPatterns = [
        // Indonesia
        /(\d+)\s*anggota/i,
        /anggota\s*[:\-•]?\s*(\d+)/i,
        /grup\s*[:\-•]?\s*(\d+)\s*anggota/i,
        
        // English
        /(\d+)\s*members?/i,
        /members?\s*[:\-•]?\s*(\d+)/i,
        /group\s*[:\-•]?\s*(\d+)\s*members?/i,
        
        // Arabic
        /(\d+)\s*أعضاء/i,
        /أعضاء\s*[:\-•]?\s*(\d+)/i,
        
        // Chinese
        /(\d+)\s*成员/i,
        /成员\s*[:\-•]?\s*(\d+)/i,
        
        // General pattern dengan simbol • yang sering muncul di WhatsApp
        /\s(\d+)\s*anggota/i,
        /•\s*(\d+)\s*anggota/i,
        /grup\s*•\s*(\d+)/i
    ];

    // Cari jumlah anggota terlebih dahulu
    for (const line of lines) {
        for (const pattern of memberPatterns) {
            const match = line.match(pattern);
            if (match) {
                const count = parseInt(match[1]);
                // Validasi range yang masuk akal untuk grup
                if (count >= 2 && count <= 1000000) {
                    memberCount = count;
                    console.log(`✅ Found member count: ${count} from line: "${line}"`);
                    break;
                }
            }
        }
        if (memberCount !== null) break;
    }

    // Algoritma khusus untuk mencari nama grup di WhatsApp
    const candidates = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Skip baris kosong atau terlalu pendek
        if (line.length < 1) continue;
        
        // Skip baris yang jelas bukan nama grup
        const skipPatterns = [
            /grup\s*[:\-•]/i,
            /group\s*[:\-•]/i,
            /anggota/i,
            /members?/i,
            /chat\s*audio/i,
            /tambah/i,
            /cari/i,
            /search/i,
            /add/i,
            /online/i,
            /terakhir\s*dilihat/i,
            /last\s*seen/i,
            /dibuat/i,
            /created/i,
            /notifikasi/i,
            /notification/i,
            /visibilitas/i,
            /visibility/i,
            /pesan/i,
            /message/i,
            /enkripsi/i,
            /encryption/i,
            /\+\d{10,}/i, // Phone numbers
            /^\d{1,2}$/, // Single/double digits only
            /[←→↓↑⬅➡⬇⬆]/,
            /[📱💬🔍⚙️📞🎥🔊👥]/
        ];
        
        const shouldSkip = skipPatterns.some(pattern => pattern.test(line));
        if (shouldSkip) continue;
        
        // Scoring system untuk nama grup
        let score = 0;
        
        // Prioritas tinggi untuk posisi atas (nama grup biasanya di atas)
        if (i <= 2) score += 15;
        if (i <= 4) score += 10;
        
        // Prioritas untuk panjang yang wajar
        if (line.length >= 2 && line.length <= 30) score += 8;
        if (line.length >= 3 && line.length <= 20) score += 5;
        
        // Prioritas untuk line yang prominent (biasanya nama grup lebih besar)
        // WhatsApp biasanya taruh nama grup dengan font besar di posisi mencolok
        if (/^\d{2,}$/.test(line)) score += 10; // Seperti "292"
        if (/^[A-Za-z0-9\s\u0080-\uFFFF]{2,30}$/.test(line)) score += 7;
        
        // Penalti untuk line yang mengandung kata kunci sistem
        if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(line)) score -= 10; // Tanggal
        if (/\d{1,2}:\d{2}/.test(line)) score -= 5; // Waktu
        
        // Bonus untuk line yang terlihat seperti nama/label
        if (/^[A-Z]/.test(line)) score += 3; // Dimulai huruf kapital
        if (!/[.,;:!?]/.test(line)) score += 2; // Tidak ada punctuation
        
        candidates.push({ line, score, index: i });
    }
    
    // Urutkan kandidat berdasarkan score
    candidates.sort((a, b) => b.score - a.score);
    
    if (candidates.length > 0) {
        groupName = candidates[0].line;
        console.log(`✅ Selected group name: "${groupName}" with score: ${candidates[0].score}`);
        console.log('📊 Top candidates:', candidates.slice(0, 3).map(c => `"${c.line}" (${c.score})`));
    }
    
    // Fallback untuk member count jika belum ketemu
    if (memberCount === null) {
        // Cari angka yang masuk akal di sekitar grup info
        const numbers = [];
        for (const line of lines) {
            const matches = line.match(/\d+/g);
            if (matches) {
                matches.forEach(match => {
                    const num = parseInt(match);
                    if (num >= 2 && num <= 1000000) {
                        numbers.push(num);
                    }
                });
            }
        }
        
        if (numbers.length > 0) {
            // Ambil angka yang paling mungkin jumlah anggota
            // Biasanya bukan angka pertama (yang mungkin nama grup)
            memberCount = numbers.length > 1 ? numbers[1] : numbers[0];
            console.log(`🔄 Fallback member count: ${memberCount}`);
        }
    }

    // Clean up nama grup
    if (groupName) {
        groupName = groupName.replace(/[^\w\s\u0080-\uFFFF\-_.()]/g, '').trim();
        if (!groupName) groupName = 'Unknown Group';
    }

    const result = {
        groupName: groupName || 'Unknown Group',
        memberCount: memberCount || 0,
        success: groupName !== null && memberCount !== null
    };

    console.log('🎯 Final result:', result);
    return result;
}

// Fungsi download foto
async function downloadPhoto(fileId) {
    try {
        const file = await bot.getFile(fileId);
        const filePath = file.file_path;
        const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
        
        const localPath = path.join(__dirname, 'temp', `${fileId}.jpg`);
        
        if (!fs.existsSync(path.join(__dirname, 'temp'))) {
            fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });
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
    const statusText = isProcessing ? '⏳ Sedang Memproses foto tunggu ...' : '✅ Siap untuk foto berikutnya';
    const groupsList = groups.length > 0 ? 
        groups.map((g, i) => `${i + 1}. ${g.name} - ${g.members} anggota`).join('\n') : 
        'Belum ada grup yang terdeteksi';
    
    const text = `🤖 **Bot Rekap Grup**\n\n${statusText}\n\n📊 **Hasil Sementara:**\n Nama : ${groupsList}\n\n💡 Kirim foto grup lainnya atau klik Selesai untuk melihat total`;
    
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

    console.log(`🚀 Processing batch photos for user ${userId}`);
    session.isProcessing = true;
    
    // Kirim pesan processing
    const processingMsg = await bot.sendMessage(chatId, 
        '🤖 **Bot Rekap Grup**\n\n⏳ Tunggu Masih Memproses foto...\n\n📊 **Hasil Sementara:**\nBelum ada grup yang terdeteksi\n\n💡 Kirim foto grup lainnya atau klik Selesai untuk melihat total', 
        {
            parse_mode: 'Markdown',
            reply_markup: createKeyboard()
        }
    );
    
    session.processingMessageId = processingMsg.message_id;
    
    // Proses semua foto di queue
    for (const photoData of session.photoQueue) {
        try {
            console.log(`📸 Processing photo: ${photoData.fileId}`);
            
            const imagePath = await downloadPhoto(photoData.fileId);
            const extractedText = await extractTextFromImage(imagePath);
            const groupInfo = parseWhatsAppGroupInfo(extractedText);
            
            if (groupInfo.success && groupInfo.memberCount > 0) {
                session.addGroup(groupInfo.groupName, groupInfo.memberCount);
                console.log(`✅ Added group: ${groupInfo.groupName} - ${groupInfo.memberCount} members`);
            }

            // Hapus file temporary
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }
            
            // Hapus foto processed jika ada
            const processedPath = imagePath.replace('.jpg', '_processed.jpg');
            if (fs.existsSync(processedPath)) {
                fs.unlinkSync(processedPath);
            }

            // Hapus pesan foto user
            try {
                await bot.deleteMessage(chatId, photoData.messageId);
            } catch (error) {
                console.error('Error deleting photo message:', error.message);
            }

            // Update hasil sementara
            await updateProcessingMessage(chatId, session.processingMessageId, session.groups, true);
            
        } catch (error) {
            console.error(`❌ Error processing photo ${photoData.fileId}:`, error.message);
        }
    }
    
    // Clear queue dan update final
    session.photoQueue = [];
    await updateProcessingMessage(chatId, session.processingMessageId, session.groups, false);
    session.isProcessing = false;
    
    console.log(`✅ Batch processing complete. Found ${session.groups.length} groups.`);
}

// Handler untuk foto
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    console.log(`📸 Photo received from user ${userId}`);
    
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

    // Tambah foto ke queue
    const photoId = msg.photo[msg.photo.length - 1].file_id;
    session.photoQueue.push({
        fileId: photoId,
        messageId: msg.message_id
    });

    // Clear timer sebelumnya
    if (session.timer) {
        clearTimeout(session.timer);
    }

    // Set timer 10 detik
    session.timer = setTimeout(async () => {
        await processBatchPhotos(userId, chatId);
    }, 10000);

    console.log(`⏰ Timer set, waiting for more photos. Queue: ${session.photoQueue.length}`);
});

// Handler untuk callback query (button)
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

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

// Command handlers
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!ADMIN_IDS.includes(userId)) {
        await bot.sendMessage(chatId, '❌ Maaf, hanya admin yang dapat menggunakan bot ini.');
        return;
    }

    const welcomeText = `🤖 **Selamat datang di Bot Rekap Grup Advanced!**

📋 **Cara Penggunaan:**
1. Kirim foto-foto info grup WhatsApp (bisa banyak sekaligus)
2. Bot akan menunggu 10 detik setelah foto terakhir
3. Bot akan memproses dengan OCR canggih dan menampilkan hasil
4. Klik **Selesai** untuk melihat total atau lanjut kirim foto lagi

✨ **Fitur Unggulan:**
• OCR.space API untuk akurasi tinggi
• Preprocessing gambar otomatis
• Deteksi khusus format WhatsApp
• Support semua bahasa
• Proses batch super cepat
• Hasil yang rapi dan akurat

/help untuk bantuan

💡 Kirim foto pertama untuk memulai!`;

    await bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!ADMIN_IDS.includes(userId)) {
        await bot.sendMessage(chatId, '❌ Maaf, hanya admin yang dapat menggunakan bot ini.');
        return;
    }

    const helpText = `📚 **Panduan Bot Rekap Grup Advanced**

🔧 **Commands:**
• /start - Mulai menggunakan bot
• /help - Tampilkan panduan ini
• /status - Cek status bot
• /test - Test OCR engine

📸 **Format Foto yang Didukung:**
• Screenshot info grup WhatsApp
• Foto dengan kualitas HD untuk hasil terbaik
• Format JPG, PNG

⚙️ **Tips untuk Hasil Terbaik:**
• Pastikan foto jernih dan pencahayaan baik
• Screenshot penuh dari bagian info grup
• Hindari foto yang blur, gelap, atau terpotong

🚀 **Teknologi:**
• OCR.space API (akurasi tinggi)
• Image preprocessing otomatis
• Multi-engine fallback
• Algoritma deteksi WhatsApp khusus`;

    await bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
});

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
📸 Foto dalam antrian: ${session.photoQueue.length}

📋 **Daftar Grup:**
${session.getGroupsList()}`;

        await bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
    } else {
        await bot.sendMessage(chatId, '📊 **Status:** Tidak ada rekap yang sedang berjalan.\n\nKirim foto untuk memulai rekap baru!', { parse_mode: 'Markdown' });
    }
});

// Error handlers
bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('SIGINT', () => {
    console.log('Bot is shutting down...');
    bot.stopPolling();
    process.exit(0);
});

console.log('🚀 Bot Rekap Grup Advanced started successfully!');
console.log('🔥 Features: OCR.space API + Image Preprocessing + WhatsApp Detection');
console.log('📱 Ready to process group screenshots with high accuracy!');
console.log('👥 Authorized admins:', ADMIN_IDS);
