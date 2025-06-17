//
const TelegramBot = require('node-telegram-bot-api');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Konfigurasi Bot
const BOT_TOKEN = '7782738957:AAE1hBtX3eIEop26IU07X_YSSaK-ki2RgNA';
const ADMIN_IDS = [5988451717, 1285724437];

// Tesseract configuration yang optimal
const TESSERACT_CONFIG = {
    lang: 'eng+ind+ara+chi_sim+jpn+kor+tha+vie+rus+spa+fra+deu',
    tessedit_pageseg_mode: Tesseract.PSM.AUTO,
    tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY,
    preserve_interword_spaces: '1',
    logger: () => {} // Silent mode
};

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
        this.photoCounter = 0;
        this.lastMessageContent = '';
    }

    addGroup(name, members) {
        this.photoCounter++;
        this.groups.push({ 
            order: this.photoCounter,
            name: name,
            members: members,
            timestamp: Date.now()
        });
    }

    getTotalMembers() {
        return this.groups.reduce((sum, group) => sum + group.members, 0);
    }

    getMembersCalculation() {
        const memberCounts = this.groups.map(g => g.members);
        return `${memberCounts.join(' + ')} = ${this.getTotalMembers()}`;
    }

    getFormattedResults() {
        if (this.groups.length === 0) return 'Belum ada grup terdeteksi';
        
        let result = '';
        this.groups.forEach((group, index) => {
            result += `**${index + 1}.**\n`;
            result += `Nama Grup: ${group.name}\n`;
            result += `Anggota: ${group.members}\n\n`;
        });
        
        result += `🧮 **TOTAL ANGGOTA:**\n${this.getMembersCalculation()}`;
        return result;
    }

    reset() {
        this.groups = [];
        this.isProcessing = false;
        this.lastPhotoTime = null;
        this.processingMessageId = null;
        this.photoQueue = [];
        this.photoCounter = 0;
        this.lastMessageContent = '';
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}

// Fungsi OCR dengan Tesseract
async function performTesseractOCR(imagePath) {
    try {
        console.log('🔍 Starting Tesseract OCR...');
        
        const { data: { text, confidence } } = await Tesseract.recognize(imagePath, TESSERACT_CONFIG.lang, TESSERACT_CONFIG);
        
        console.log(`✅ Tesseract completed with ${confidence.toFixed(1)}% confidence`);
        console.log('📄 Raw OCR Text:');
        console.log('=' .repeat(60));
        console.log(text);
        console.log('=' .repeat(60));
        
        return text;
        
    } catch (error) {
        console.error('❌ Tesseract OCR Error:', error.message);
        throw new Error(`Tesseract failed: ${error.message}`);
    }
}

// Fungsi parsing yang SEDERHANA dan AKURAT
function parseWhatsAppSimple(ocrText) {
    console.log('\n🎯 Simple Accurate WhatsApp Parsing...');
    
    // Clean dan split text
    const lines = ocrText
        .split(/[\n\r]+/)
        .map(line => line.trim())
        .filter(line => line.length > 0);
    
    console.log('📋 All Lines:');
    lines.forEach((line, i) => console.log(`  ${i}: "${line}"`));
    
    let groupName = null;
    let memberCount = null;
    
    // === STEP 1: CARI JUMLAH ANGGOTA (LEBIH MUDAH DIDETEKSI) ===
    console.log('\n🔍 STEP 1: Finding Member Count...');
    
    // Pattern untuk mendeteksi jumlah anggota
    const memberPatterns = [
        // Indonesia: "Grup • 80 anggota" atau "80 anggota"
        /(\d+)\s*anggota/i,
        
        // English: "Group • 80 members" atau "80 members"
        /(\d+)\s*members?/i,
        
        // Dengan bullet: "• 80 anggota"
        /•\s*(\d+)\s*(?:anggota|members?)/i,
        
        // Format grup: "Grup • 80"
        /grup\s*[•·]\s*(\d+)/i,
        /group\s*[•·]\s*(\d+)/i,
        
        // Arabic
        /(\d+)\s*أعضاء/i,
        
        // Chinese
        /(\d+)\s*成员/i,
        /(\d+)\s*成員/i,
        
        // Japanese
        /(\d+)\s*メンバー/i,
        
        // Korean
        /(\d+)\s*구성원/i
    ];
    
    // Cari member count
    for (const line of lines) {
        for (let i = 0; i < memberPatterns.length; i++) {
            const pattern = memberPatterns[i];
            const match = line.match(pattern);
            if (match) {
                const count = parseInt(match[1]);
                if (count >= 1 && count <= 1000000) {
                    memberCount = count;
                    console.log(`✅ Found member count: ${count} from line: "${line}"`);
                    break;
                }
            }
        }
        if (memberCount !== null) break;
    }
    
    // === STEP 2: CARI NAMA GRUP (BARIS PERTAMA YANG BUKAN INFO) ===
    console.log('\n🔍 STEP 2: Finding Group Name...');
    
    // Keywords yang pasti BUKAN nama grup
    const notGroupNameKeywords = [
        'grup', 'group', 'anggota', 'members', 'member',
        'chat', 'audio', 'tambah', 'add', 'cari', 'search',
        'notifikasi', 'notification', 'info', 'description',
        'deskripsi', 'media', 'visibilitas', 'visibility',
        'pesan', 'message', 'enkripsi', 'encryption',
        'online', 'last', 'seen', 'terakhir', 'dilihat'
    ];
    
    // Cari nama grup - ambil baris pertama yang layak
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Skip baris kosong
        if (line.length === 0) continue;
        
        // Skip jika mengandung keyword yang bukan nama grup
        const containsNotGroupName = notGroupNameKeywords.some(keyword => 
            line.toLowerCase().includes(keyword.toLowerCase())
        );
        if (containsNotGroupName) {
            console.log(`⏭️ Line ${i}: Skipped (contains keyword) - "${line}"`);
            continue;
        }
        
        // Skip jika mengandung member pattern (ini baris info anggota)
        const containsMemberPattern = memberPatterns.some(pattern => pattern.test(line));
        if (containsMemberPattern) {
            console.log(`⏭️ Line ${i}: Skipped (member info) - "${line}"`);
            continue;
        }
        
        // Skip UI symbols
        if (/[←→↓↑⬅➡⬇⬆📱💬🔍⚙️📞🎥🔊👥🔔]/.test(line)) {
            console.log(`⏭️ Line ${i}: Skipped (UI symbols) - "${line}"`);
            continue;
        }
        
        // Skip phone numbers
        if (/^\+?\d{8,15}$/.test(line.replace(/[\s\-()]/g, ''))) {
            console.log(`⏭️ Line ${i}: Skipped (phone number) - "${line}"`);
            continue;
        }
        
        // Skip dates and times
        if (/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(line) || /\d{1,2}:\d{2}/.test(line)) {
            console.log(`⏭️ Line ${i}: Skipped (date/time) - "${line}"`);
            continue;
        }
        
        // Skip URLs and emails
        if (/https?:\/\/|www\.|\.com|@/.test(line)) {
            console.log(`⏭️ Line ${i}: Skipped (URL/email) - "${line}"`);
            continue;
        }
        
        // Ini adalah kandidat nama grup yang baik!
        groupName = line.trim();
        console.log(`✅ Line ${i}: Selected as GROUP NAME - "${groupName}"`);
        break;
    }
    
    // === FALLBACK SYSTEMS ===
    
    // Fallback untuk member count jika belum ketemu
    if (memberCount === null) {
        console.log('\n🔄 Fallback: Looking for any reasonable number...');
        for (const line of lines) {
            const numbers = line.match(/\d+/g);
            if (numbers) {
                for (const numStr of numbers) {
                    const num = parseInt(numStr);
                    if (num >= 2 && num <= 10000) { // Range wajar untuk grup
                        memberCount = num;
                        console.log(`🔄 Fallback member count: ${num} from "${line}"`);
                        break;
                    }
                }
            }
            if (memberCount !== null) break;
        }
    }
    
    // Fallback untuk group name jika belum ketemu
    if (!groupName && lines.length > 0) {
        console.log('\n🔄 Fallback: Using first line as group name...');
        groupName = lines[0].trim();
        console.log(`🔄 Fallback group name: "${groupName}"`);
    }
    
    const result = {
        groupName: groupName || 'Unknown Group',
        memberCount: memberCount || 0,
        success: groupName !== null && memberCount !== null
    };
    
    console.log('\n🎯 === SIMPLE PARSING RESULT ===');
    console.log(`   Group Name: "${result.groupName}"`);
    console.log(`   Member Count: ${result.memberCount}`);
    console.log(`   Success: ${result.success}`);
    console.log('==============================\n');
    
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
            const request = https.get(url, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}`));
                    return;
                }
                
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve(localPath);
                });
            });
            
            request.on('error', reject);
            file.on('error', reject);
            
            request.setTimeout(30000, () => {
                request.destroy();
                reject(new Error('Download timeout'));
            });
        });
        
    } catch (error) {
        throw new Error(`Download failed: ${error.message}`);
    }
}

// Fungsi keyboard
function createKeyboard(hasResults = false) {
    if (hasResults) {
        return {
            inline_keyboard: [
                [{ text: '✅ Selesai & Lihat Total', callback_data: 'finish' }],
                [{ text: '🔄 Reset Data', callback_data: 'reset' }]
            ]
        };
    }
    return null;
}

// Fungsi update message dengan progress yang jelas
async function updateMessageWithProgress(chatId, messageId, groups, isProcessing = false, currentPhoto = 0, totalPhotos = 0) {
    try {
        let text = `🤖 **BOT REKAP GRUP - TESSERACT OCR**\n\n`;
        
        if (isProcessing && currentPhoto > 0) {
            text += `⏳ **Memproses foto ${currentPhoto}/${totalPhotos}...**\n\n`;
        } else if (!isProcessing && totalPhotos > 0) {
            text += `✅ **Selesai memproses ${totalPhotos} foto**\n\n`;
        } else {
            text += `✅ **Siap menerima foto berikutnya**\n\n`;
        }
        
        if (groups.length > 0) {
            text += `📊 **HASIL DETEKSI (${groups.length} grup):**\n\n`;
            
            groups.forEach((group, index) => {
                text += `**${index + 1}.**\n`;
                text += `Nama Grup: ${group.name}\n`;
                text += `Anggota: ${group.members}\n\n`;
            });
            
            const memberCounts = groups.map(g => g.members);
            const total = groups.reduce((sum, g) => sum + g.members, 0);
            text += `🧮 **TOTAL ANGGOTA:**\n${memberCounts.join(' + ')} = ${total}\n\n`;
            text += `💡 Kirim foto lagi atau klik Selesai`;
        } else {
            text += `📊 **Belum ada grup terdeteksi**\n\n💡 Kirim foto screenshot grup WhatsApp`;
        }
        
        const session = userSessions.get(chatId);
        
        // Check for content changes
        if (session && session.lastMessageContent === text) {
            return messageId;
        }
        
        if (session) {
            session.lastMessageContent = text;
        }
        
        const keyboard = createKeyboard(groups.length > 0);
        
        // Try edit first
        if (messageId) {
            try {
                await bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
                return messageId;
            } catch (editError) {
                // If edit fails, send new message
            }
        }
        
        // Send new message
        try {
            const newMsg = await bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
            
            // Try to delete old message
            if (messageId) {
                try {
                    await bot.deleteMessage(chatId, messageId);
                } catch (deleteError) {
                    // Ignore delete errors
                }
            }
            
            return newMsg.message_id;
        } catch (sendError) {
            console.error('❌ Message send failed:', sendError.message);
            return null;
        }
        
    } catch (error) {
        console.error('❌ Message update error:', error.message);
        return null;
    }
}

// Fungsi proses foto batch dengan progress yang jelas
async function processBatchPhotos(userId, chatId) {
    const session = userSessions.get(userId);
    if (!session || session.isProcessing || session.photoQueue.length === 0) return;

    const totalPhotos = session.photoQueue.length;
    console.log(`🚀 Processing ${totalPhotos} photos for user ${userId}`);
    session.isProcessing = true;
    
    // Initialize processing message
    if (!session.processingMessageId) {
        try {
            const processingMsg = await bot.sendMessage(chatId, 
                `🤖 **BOT REKAP GRUP - TESSERACT OCR**\n\n⏳ **Memproses foto 0/${totalPhotos}...**\n\n📊 **Belum ada grup terdeteksi**\n\n💡 Kirim foto screenshot grup WhatsApp`, 
                { parse_mode: 'Markdown' }
            );
            session.processingMessageId = processingMsg.message_id;
        } catch (error) {
            console.error('❌ Failed to create processing message');
        }
    }
    
    // Process photos with progress
    const currentQueue = [...session.photoQueue];
    session.photoQueue = [];
    
    for (let photoIndex = 0; photoIndex < currentQueue.length; photoIndex++) {
        const photoData = currentQueue[photoIndex];
        const currentPhotoNumber = photoIndex + 1;
        
        try {
            console.log(`\n📸 === PROCESSING PHOTO ${currentPhotoNumber}/${totalPhotos} ===`);
            console.log(`Photo ID: ${photoData.fileId}`);
            
            // Update progress
            session.processingMessageId = await updateMessageWithProgress(
                chatId, 
                session.processingMessageId, 
                session.groups, 
                true, 
                currentPhotoNumber, 
                totalPhotos
            );
            
            // Download photo
            const imagePath = await downloadPhoto(photoData.fileId);
            console.log(`✅ Downloaded photo ${currentPhotoNumber}: ${imagePath}`);
            
            // Perform OCR
            const extractedText = await performTesseractOCR(imagePath);
            
            // Parse dengan algoritma sederhana
            const groupInfo = parseWhatsAppSimple(extractedText);
            
            if (groupInfo.success && groupInfo.memberCount > 0) {
                session.addGroup(groupInfo.groupName, groupInfo.memberCount);
                
                console.log(`✅ Photo ${currentPhotoNumber}: Successfully added "${groupInfo.groupName}" - ${groupInfo.memberCount} members`);
                
                // Update hasil incremental
                session.processingMessageId = await updateMessageWithProgress(
                    chatId, 
                    session.processingMessageId, 
                    session.groups, 
                    true, 
                    currentPhotoNumber, 
                    totalPhotos
                );
            } else {
                console.log(`⚠️ Photo ${currentPhotoNumber}: No valid data detected`);
            }

            // Cleanup
            try {
                if (fs.existsSync(imagePath)) {
                    fs.unlinkSync(imagePath);
                }
            } catch (cleanupError) {
                console.log('⚠️ Cleanup warning:', cleanupError.message);
            }

            // Delete user photo
            try {
                await bot.deleteMessage(chatId, photoData.messageId);
                console.log(`🗑️ Deleted user photo ${currentPhotoNumber}`);
            } catch (deleteError) {
                console.log('⚠️ Could not delete user photo');
            }
            
        } catch (error) {
            console.error(`❌ Error processing photo ${currentPhotoNumber}/${totalPhotos}:`, error.message);
        }
    }
    
    // Final update
    session.processingMessageId = await updateMessageWithProgress(
        chatId, 
        session.processingMessageId, 
        session.groups, 
        false, 
        0, 
        totalPhotos
    );
    session.isProcessing = false;
    
    console.log(`\n✅ === BATCH PROCESSING COMPLETE ===`);
    console.log(`Total groups detected: ${session.groups.length}`);
    console.log(`Total members: ${session.getTotalMembers()}`);
}

// Handler untuk foto
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    console.log(`📸 Photo received from user ${userId}`);
    
    if (!ADMIN_IDS.includes(userId)) {
        await bot.sendMessage(chatId, '❌ Maaf, hanya admin yang dapat menggunakan bot ini.');
        return;
    }

    if (!userSessions.has(userId)) {
        userSessions.set(userId, new UserSession(userId));
    }

    const session = userSessions.get(userId);
    session.lastPhotoTime = Date.now();

    const photoId = msg.photo[msg.photo.length - 1].file_id;
    const photoOrder = session.photoQueue.length + 1;
    
    session.photoQueue.push({
        fileId: photoId,
        messageId: msg.message_id,
        order: photoOrder,
        timestamp: Date.now()
    });

    console.log(`📥 Photo queued #${photoOrder}. Total queue: ${session.photoQueue.length}`);

    if (session.timer) {
        clearTimeout(session.timer);
    }

    session.timer = setTimeout(async () => {
        await processBatchPhotos(userId, chatId);
    }, 10000);

    console.log(`⏰ Timer set for 10 seconds. Queue: ${session.photoQueue.length} photos`);
});

// Handler untuk callback query
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    if (!ADMIN_IDS.includes(userId)) {
        await bot.answerCallbackQuery(query.id, { text: 'Hanya admin yang dapat menggunakan bot ini.' });
        return;
    }

    const session = userSessions.get(userId);

    try {
        switch (data) {
            case 'finish':
                if (session && session.groups.length > 0) {
                    const finalText = `🎉 **REKAP GRUP SELESAI!**\n\n${session.getFormattedResults()}`;
                    
                    await bot.editMessageText(finalText, {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔄 Mulai Rekap Baru', callback_data: 'reset' }]
                            ]
                        }
                    });
                } else {
                    await bot.answerCallbackQuery(query.id, { text: 'Belum ada grup yang terdeteksi!' });
                }
                break;

            case 'reset':
                if (session) {
                    session.reset();
                }
                await bot.editMessageText('🔄 **Data direset!**\n\nKirim foto grup untuk memulai rekap baru.', {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown'
                });
                break;
        }
    } catch (error) {
        console.error('⚠️ Callback error:', error.message);
    }

    await bot.answerCallbackQuery(query.id);
});

// Commands
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!ADMIN_IDS.includes(userId)) {
        await bot.sendMessage(chatId, '❌ Maaf, hanya admin yang dapat menggunakan bot ini.');
        return;
    }

    const welcomeText = `🤖 **SIMPLE ACCURATE TESSERACT BOT**

🎯 **Algoritma Sederhana dan Akurat**

✨ **Cara Kerja:**
• Tesseract OCR yang stabil
• Parsing sederhana tapi tepat sasaran
• Nama grup = baris pertama yang bukan info
• Jumlah anggota = extract dari "X anggota"
• Progress jelas (foto X/Y)

📊 **Contoh untuk Screenshot Anda:**
"292" → Nama Grup ✅
"Grup • 80 anggota" → 80 Anggota ✅

📋 **Format Output:**
**1.**
Nama Grup: 292
Anggota: 80

🚀 **Cara Pakai:**
1. Screenshot info grup WhatsApp
2. Kirim foto (bisa banyak sekaligus)
3. Tunggu 10 detik untuk auto-process
4. Lihat progress (foto X/Y)
5. Klik "Selesai" untuk total

💡 Kirim foto untuk memulai!`;

    await bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown' });
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
        const statusText = `📊 **STATUS REKAP**

🔄 Status: ${session.isProcessing ? 'Memproses' : 'Siap'}
📈 Total grup: ${session.groups.length}
👥 Total anggota: ${session.getTotalMembers()}
📸 Foto antrian: ${session.photoQueue.length}

${session.getFormattedResults()}`;

        await bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
    } else {
        await bot.sendMessage(chatId, '📊 **STATUS:** Belum ada rekap.\n\nKirim foto untuk memulai!', { parse_mode: 'Markdown' });
    }
});

bot.onText(/\/reset/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!ADMIN_IDS.includes(userId)) {
        await bot.sendMessage(chatId, '❌ Maaf, hanya admin yang dapat menggunakan bot ini.');
        return;
    }

    const session = userSessions.get(userId);
    if (session) {
        session.reset();
        await bot.sendMessage(chatId, '🔄 **Data berhasil direset!**\n\nKirim foto grup untuk memulai rekap baru.', { parse_mode: 'Markdown' });
    } else {
        await bot.sendMessage(chatId, '📊 Tidak ada data untuk direset.');
    }
});

// Enhanced error handlers
bot.on('polling_error', (error) => {
    console.error('❌ Polling error:', error.code || 'Unknown', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
});

process.on('SIGINT', () => {
    console.log('🛑 Bot shutting down gracefully...');
    
    // Cleanup all sessions
    for (const [userId, session] of userSessions) {
        if (session.timer) {
            clearTimeout(session.timer);
        }
    }
    
    // Cleanup temp files
    try {
        const tempDir = path.join(__dirname, 'temp');
        if (fs.existsSync(tempDir)) {
            const files = fs.readdirSync(tempDir);
            for (const file of files) {
                fs.unlinkSync(path.join(tempDir, file));
            }
            console.log('🧹 Temp files cleaned');
        }
    } catch (cleanupError) {
        console.log('⚠️ Cleanup warning:', cleanupError.message);
    }
    
    bot.stopPolling();
    process.exit(0);
});

// Startup messages
console.log('🚀 SIMPLE ACCURATE TESSERACT BOT STARTED!');
console.log('🎯 Algorithm: Simple but accurate parsing');
console.log('📍 Focus: Group name = first valid line, Members = extract numbers');
console.log('🔤 Languages:', TESSERACT_CONFIG.lang);
console.log('👥 Authorized Admins:', ADMIN_IDS);
console.log('📱 Ready for accurate WhatsApp group detection!');
console.log('================================================');
