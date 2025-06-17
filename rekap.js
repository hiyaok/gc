//
const TelegramBot = require('node-telegram-bot-api');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Konfigurasi Bot
const BOT_TOKEN = '7782738957:AAE1hBtX3eIEop26IU07X_YSSaK-ki2RgNA';
const ADMIN_IDS = [5988451717, 1285724437];

// Tesseract configuration untuk akurasi optimal
const TESSERACT_CONFIG = {
    lang: 'eng+ind+ara+chi_sim+jpn+kor+tha+vie+rus+spa+fra+deu',
    tessedit_pageseg_mode: Tesseract.PSM.AUTO,
    tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY,
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
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

// Fungsi OCR dengan Tesseract yang dioptimalkan
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

// Fungsi parsing yang sangat spesifik untuk posisi WhatsApp
function parseWhatsAppByPosition(ocrText) {
    console.log('\n🎯 Position-Based WhatsApp Parsing...');
    
    // Clean dan split text berdasarkan line breaks
    const lines = ocrText
        .split(/[\n\r]+/)
        .map(line => line.trim())
        .filter(line => line.length > 0);
    
    console.log('📋 Detected Lines by Position:');
    lines.forEach((line, i) => console.log(`  Position ${i}: "${line}"`));
    
    let groupName = null;
    let memberCount = null;
    
    // === STEP 1: DETEKSI NAMA GRUP (PRIORITAS POSISI ATAS) ===
    console.log('\n🔍 STEP 1: Position-Based Group Name Detection...');
    
    // Keywords yang menandakan BUKAN nama grup
    const excludeFromGroupName = [
        // Indonesia
        'grup', 'anggota', 'chat', 'audio', 'tambah', 'cari', 'notifikasi', 'visibilitas', 
        'pesan', 'enkripsi', 'dibuat', 'terakhir', 'dilihat', 'online', 'ketik', 'info', 
        'deskripsi', 'media', 'mati', 'semua', 'tersimpan',
        
        // English
        'group', 'members', 'member', 'chat', 'audio', 'add', 'search', 'notification', 
        'visibility', 'message', 'encryption', 'created', 'last', 'seen', 'online', 
        'typing', 'info', 'description', 'media', 'mute', 'all', 'saved',
        
        // UI elements
        'back', 'menu', 'settings', 'profile', 'contact', 'call', 'video', 'voice',
        'camera', 'gallery', 'document', 'location', 'status', 'archive', 'pin'
    ];
    
    // Cari nama grup di posisi-posisi atas
    for (let i = 0; i < Math.min(lines.length, 6); i++) {
        const line = lines[i];
        
        // Skip baris kosong
        if (line.length === 0) continue;
        
        // Skip baris dengan exclude keywords
        const hasExcludeKeyword = excludeFromGroupName.some(keyword => 
            line.toLowerCase().includes(keyword.toLowerCase())
        );
        if (hasExcludeKeyword) {
            console.log(`⏭️ Position ${i}: Skipped exclude keyword - "${line}"`);
            continue;
        }
        
        // Skip UI symbols
        if (/[←→↓↑⬅➡⬇⬆📱💬🔍⚙️📞🎥🔊👥🔔⚡🗂️📋📄🔒]/.test(line)) {
            console.log(`⏭️ Position ${i}: Skipped UI symbols - "${line}"`);
            continue;
        }
        
        // Skip phone numbers
        if (/^\+?\d{8,15}$/.test(line.replace(/[\s\-()]/g, ''))) {
            console.log(`⏭️ Position ${i}: Skipped phone number - "${line}"`);
            continue;
        }
        
        // Skip email addresses
        if (/\S+@\S+\.\S+/.test(line)) {
            console.log(`⏭️ Position ${i}: Skipped email - "${line}"`);
            continue;
        }
        
        // Skip dates and times
        if (/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(line) || /\d{1,2}:\d{2}/.test(line)) {
            console.log(`⏭️ Position ${i}: Skipped date/time - "${line}"`);
            continue;
        }
        
        // Skip URLs
        if (/https?:\/\/|www\.|\.com|\.org|\.net/.test(line)) {
            console.log(`⏭️ Position ${i}: Skipped URL - "${line}"`);
            continue;
        }
        
        // Ini kandidat nama grup yang valid!
        groupName = line.trim();
        console.log(`✅ Position ${i}: Selected as GROUP NAME - "${groupName}"`);
        break;
    }
    
    // === STEP 2: DETEKSI JUMLAH ANGGOTA (PRIORITAS POSISI BAWAH NAMA GRUP) ===
    console.log('\n🔍 STEP 2: Position-Based Member Count Detection...');
    
    // Pattern untuk deteksi anggota dengan semua bahasa
    const memberPatterns = [
        // Indonesia - WhatsApp format: "Grup • 80 anggota"
        /(?:grup|group)\s*[•·∙◦▪▫]\s*(\d+)\s*anggota/i,
        
        // Indonesia - Simple format: "80 anggota"
        /(\d+)\s*anggota/i,
        
        // English - WhatsApp format: "Group • 80 members"
        /(?:grup|group)\s*[•·∙◦▪▫]\s*(\d+)\s*members?/i,
        
        // English - Simple format: "80 members"
        /(\d+)\s*members?/i,
        
        // Format dengan bullet: "• 80 anggota/members"
        /[•·∙◦▪▫]\s*(\d+)\s*(?:anggota|members?)/i,
        
        // Format dengan separator: "anggota: 80" atau "members: 80"
        /(?:anggota|members?)\s*[:\-•]?\s*(\d+)/i,
        
        // Arabic patterns
        /(?:مجموعة)\s*[•·∙◦▪▫]\s*(\d+)\s*(?:أعضاء)/i,
        /(\d+)\s*(?:أعضاء)/i,
        
        // Chinese patterns
        /(?:群组|群組)\s*[•·∙◦▪▫]\s*(\d+)\s*(?:成员|成員)/i,
        /(\d+)\s*(?:成员|成員)/i,
        
        // Japanese patterns
        /(?:グループ)\s*[•·∙◦▪▫]\s*(\d+)\s*(?:メンバー)/i,
        /(\d+)\s*(?:メンバー)/i,
        
        // Korean patterns
        /(?:그룹)\s*[•·∙◦▪▫]\s*(\d+)\s*(?:구성원)/i,
        /(\d+)\s*(?:구성원)/i,
        
        // Thai patterns
        /(?:กลุ่ม)\s*[•·∙◦▪▫]\s*(\d+)\s*(?:สมาชิก)/i,
        /(\d+)\s*(?:สมาชิก)/i,
        
        // Vietnamese patterns
        /(?:nhóm)\s*[•·∙◦▪▫]\s*(\d+)\s*(?:thành\s*viên)/i,
        /(\d+)\s*(?:thành\s*viên)/i,
        
        // Russian patterns
        /(?:группа)\s*[•·∙◦▪▫]\s*(\d+)\s*(?:участник)/i,
        /(\d+)\s*(?:участник)/i,
        
        // Spanish patterns
        /(?:grupo)\s*[•·∙◦▪▫]\s*(\d+)\s*(?:miembros?)/i,
        /(\d+)\s*(?:miembros?)/i,
        
        // French patterns
        /(?:groupe)\s*[•·∙◦▪▫]\s*(\d+)\s*(?:membres?)/i,
        /(\d+)\s*(?:membres?)/i,
        
        // German patterns
        /(?:gruppe)\s*[•·∙◦▪▫]\s*(\d+)\s*(?:mitglieder)/i,
        /(\d+)\s*(?:mitglieder)/i,
        
        // Generic patterns dengan bullet
        /[•·∙◦▪▫]\s*(\d+)/i
    ];
    
    // Cari member count mulai dari posisi setelah nama grup ditemukan
    let startPosition = 0;
    if (groupName) {
        // Cari posisi dimana nama grup ditemukan
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim() === groupName.trim()) {
                startPosition = i + 1; // Mulai cari dari posisi setelah nama grup
                break;
            }
        }
    }
    
    console.log(`🔍 Searching for member count starting from position ${startPosition}...`);
    
    // Cari pattern member count
    for (let patternIndex = 0; patternIndex < memberPatterns.length; patternIndex++) {
        const pattern = memberPatterns[patternIndex];
        
        // Cari mulai dari posisi setelah nama grup
        for (let i = startPosition; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(pattern);
            if (match) {
                const count = parseInt(match[1]);
                if (count >= 1 && count <= 1000000) {
                    memberCount = count;
                    console.log(`✅ Position ${i}: Found MEMBER COUNT - ${count}`);
                    console.log(`   From line: "${line}"`);
                    console.log(`   Pattern: ${patternIndex + 1}`);
                    break;
                }
            }
        }
        if (memberCount !== null) break;
    }
    
    // === FALLBACK SYSTEMS ===
    
    // Fallback untuk member count jika belum ketemu
    if (memberCount === null) {
        console.log('\n🔄 Fallback: Advanced number search...');
        const numberCandidates = [];
        
        // Cari semua angka yang masuk akal untuk jumlah anggota
        for (let i = startPosition; i < lines.length; i++) {
            const line = lines[i];
            const numbers = line.match(/\d+/g);
            if (numbers) {
                numbers.forEach(numStr => {
                    const num = parseInt(numStr);
                    if (num >= 2 && num <= 100000) {
                        let score = 0;
                        
                        // Score berdasarkan posisi (lebih dekat dengan nama grup = score tinggi)
                        score += Math.max(0, 10 - (i - startPosition));
                        
                        // Score berdasarkan konteks
                        if (/(?:grup|group|anggota|member)/i.test(line)) score += 20;
                        if (/[•·∙◦▪▫]/.test(line)) score += 15;
                        
                        // Penalty untuk angka yang terlalu besar (kemungkinan ID)
                        if (num > 10000) score -= 10;
                        if (num < 5) score -= 5;
                        
                        numberCandidates.push({ 
                            number: num, 
                            line: line, 
                            position: i,
                            score: score 
                        });
                        
                        console.log(`   Position ${i}: Number ${num} (score: ${score}) in "${line}"`);
                    }
                });
            }
        }
        
        if (numberCandidates.length > 0) {
            // Sort berdasarkan score tertinggi
            numberCandidates.sort((a, b) => b.score - a.score);
            memberCount = numberCandidates[0].number;
            console.log(`🔄 Fallback member count: ${memberCount} (score: ${numberCandidates[0].score}, position: ${numberCandidates[0].position})`);
        }
    }
    
    // Fallback untuk group name jika belum ketemu
    if (!groupName && lines.length > 0) {
        console.log('\n🔄 Fallback: Using first substantial line as group name...');
        for (let i = 0; i < Math.min(lines.length, 3); i++) {
            const line = lines[i];
            if (line.trim().length >= 1) {
                // Pastikan bukan line yang mengandung member info
                const containsMemberInfo = memberPatterns.some(pattern => pattern.test(line));
                if (!containsMemberInfo) {
                    groupName = line.trim();
                    console.log(`🔄 Fallback group name: "${groupName}" from position ${i}`);
                    break;
                }
            }
        }
    }
    
    const result = {
        groupName: groupName || 'Unknown Group',
        memberCount: memberCount || 0,
        success: groupName !== null && memberCount !== null
    };
    
    console.log('\n🎯 === POSITION-BASED FINAL RESULT ===');
    console.log(`   Group Name: "${result.groupName}"`);
    console.log(`   Member Count: ${result.memberCount}`);
    console.log(`   Success: ${result.success}`);
    console.log('====================================\n');
    
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
        
        if (isProcessing) {
            text += `⏳ **Memproses foto ${currentPhoto}/${totalPhotos}...**\n\n`;
        } else if (totalPhotos > 0) {
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
            console.log('⏭️ Skipping update - content unchanged');
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
                console.log('✅ Message updated successfully');
                return messageId;
            } catch (editError) {
                console.log('⚠️ Edit failed, sending new message');
            }
        }
        
        // Send new message if edit fails
        try {
            const newMsg = await bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
            console.log('✅ New message sent');
            
            // Try to delete old message
            if (messageId) {
                try {
                    await bot.deleteMessage(chatId, messageId);
                } catch (deleteError) {
                    console.log('⚠️ Could not delete old message');
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
            console.log(`📸 Processing photo ${currentPhotoNumber}/${totalPhotos}: ${photoData.fileId}`);
            
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
            
            // Parse dengan fokus posisi
            const groupInfo = parseWhatsAppByPosition(extractedText);
            
            if (groupInfo.success && groupInfo.memberCount > 0) {
                session.addGroup(groupInfo.groupName, groupInfo.memberCount);
                
                console.log(`✅ Photo ${currentPhotoNumber}: Added "${groupInfo.groupName}" - ${groupInfo.memberCount} members`);
                
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
    
    console.log(`✅ Batch processing complete. Total groups detected: ${session.groups.length}`);
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

    const welcomeText = `🤖 **TESSERACT POSITION-ACCURATE BOT**

🎯 **Deteksi Berdasarkan Posisi WhatsApp**

✨ **Keunggulan:**
• Tesseract OCR yang stabil
• Fokus pada posisi elemen WhatsApp
• Nama grup selalu dicari di ATAS
• Jumlah anggota dicari di BAWAH nama grup
• Progress yang jelas (foto X/Y)

📊 **Contoh untuk Screenshot Anda:**
Position 0: "292" → Nama Grup ✅
Position 1: "Grup • 80 anggota" → 80 Anggota ✅

📋 **Format Output:**
**1.**
Nama Grup: 292
Anggota: 80

🚀 **Cara Pakai:**
1. Screenshot info grup WhatsApp
2. Kirim foto (bisa banyak sekaligus)
3. Tunggu 10 detik untuk auto-process
4. Lihat progress real-time (foto X/Y)
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
console.log('🚀 TESSERACT POSITION-ACCURATE BOT STARTED!');
console.log('🎯 Focus: Position-based WhatsApp detection');
console.log('📍 Algorithm: Top=GroupName, Below=MemberCount');
console.log('🔤 Languages:', TESSERACT_CONFIG.lang);
console.log('👥 Authorized Admins:', ADMIN_IDS);
console.log('📱 Ready for WhatsApp group screenshots!');
console.log('===========================================');
