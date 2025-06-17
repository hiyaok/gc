//
const TelegramBot = require('node-telegram-bot-api');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');
const https = require('https');
const sharp = require('sharp');

// Konfigurasi Bot
const BOT_TOKEN = '7782738957:AAE1hBtX3eIEop26IU07X_YSSaK-ki2RgNA';
const ADMIN_IDS = [5988451717, 1285724437];

// Inisialisasi bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Storage untuk menyimpan data user
const userSessions = new Map();

// Konfigurasi OCR yang STABIL - hanya bahasa yang pasti tersedia
const STABLE_OCR_LANGUAGES = 'eng+ind+ara+chi_sim+jpn+kor+tha+vie+rus+spa+fra+deu';

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
        this.lastMessageContent = null; // Untuk mencegah duplicate message
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
        this.lastMessageContent = null;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}

// Fungsi preprocessing gambar yang sangat aman
async function safeImagePreprocessing(inputPath) {
    try {
        const outputPath = inputPath.replace('.jpg', '_processed.jpg');
        
        // Cek metadata gambar
        const metadata = await sharp(inputPath).metadata();
        console.log(`📐 Original image: ${metadata.width}x${metadata.height}`);
        
        // Jika gambar terlalu kecil, skip preprocessing
        if (metadata.width < 100 || metadata.height < 100) {
            console.log('⚠️ Image too small, using original');
            return inputPath;
        }
        
        // Preprocessing yang aman
        const minWidth = Math.max(1200, metadata.width);
        const minHeight = Math.max(800, metadata.height);
        
        await sharp(inputPath)
            .resize(minWidth, null, { 
                fit: 'inside',
                withoutEnlargement: false,
                kernel: sharp.kernel.lanczos3
            })
            .normalize()
            .sharpen({ sigma: 1.0, flat: 1, jagged: 1.5 })
            .gamma(1.1)
            .modulate({
                brightness: 1.05,
                saturation: 0.9
            })
            .jpeg({ quality: 90, progressive: false })
            .toFile(outputPath);
        
        console.log('✅ Image preprocessing completed successfully');
        return outputPath;
        
    } catch (error) {
        console.error('⚠️ Preprocessing failed, using original:', error.message);
        return inputPath;
    }
}

// Fungsi OCR yang sangat stabil
async function performStableOCR(imagePath) {
    try {
        console.log('🔍 Starting stable OCR process...');
        
        const processedPath = await safeImagePreprocessing(imagePath);
        
        // Konfigurasi OCR yang stabil
        const ocrConfig = {
            lang: STABLE_OCR_LANGUAGES,
            tessedit_pageseg_mode: Tesseract.PSM.AUTO,
            tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY,
            preserve_interword_spaces: '1',
            user_defined_dpi: '300',
            tessedit_do_invert: '0',
            logger: () => {} // Silent mode
        };
        
        console.log(`📝 Using languages: ${STABLE_OCR_LANGUAGES}`);
        
        const { data: { text, confidence } } = await Tesseract.recognize(processedPath, ocrConfig.lang, ocrConfig);
        
        console.log(`✅ OCR completed with ${confidence.toFixed(1)}% confidence`);
        console.log('📄 OCR Text:');
        console.log('=' .repeat(50));
        console.log(text);
        console.log('=' .repeat(50));
        
        // Cleanup processed file
        if (fs.existsSync(processedPath) && processedPath !== imagePath) {
            fs.unlinkSync(processedPath);
        }
        
        return text;
        
    } catch (error) {
        console.error('❌ OCR Error:', error.message);
        
        // Fallback dengan bahasa minimal
        try {
            console.log('🔄 Fallback: Trying with minimal languages...');
            const fallbackConfig = {
                lang: 'eng+ind',
                tessedit_pageseg_mode: Tesseract.PSM.AUTO,
                logger: () => {}
            };
            
            const { data: { text } } = await Tesseract.recognize(imagePath, fallbackConfig.lang, fallbackConfig);
            console.log('✅ Fallback OCR succeeded');
            return text;
            
        } catch (fallbackError) {
            console.error('❌ Fallback OCR also failed:', fallbackError.message);
            throw new Error(`All OCR methods failed: ${error.message}`);
        }
    }
}

// Fungsi parsing yang sangat akurat untuk WhatsApp
function parseWhatsAppGroup(ocrText) {
    console.log('\n🎯 Starting WhatsApp group parsing...');
    
    // Clean dan split text
    const lines = ocrText.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
    
    console.log('📋 All detected lines:');
    lines.forEach((line, i) => console.log(`  ${i + 1}: "${line}"`));
    
    let groupName = null;
    let memberCount = null;
    
    // === STEP 1: DETEKSI JUMLAH ANGGOTA ===
    console.log('\n🔍 STEP 1: Detecting member count...');
    
    // Pattern untuk deteksi anggota - fokus pada format WhatsApp
    const memberPatterns = [
        // Format WhatsApp: "Grup • 80 anggota"
        /(?:grup|group|مجموعة|群组|群組|グループ|그룹|กลุ่ม|nhóm|группа|grupo|groupe|gruppe)\s*[•·]\s*(\d+)\s*(?:anggota|members?|أعضاء|成员|成員|メンバー|구성원|สมาชิก|thành\s*viên|участник|miembros?|membres?|mitglieder)/i,
        
        // Format sederhana: "80 anggota"
        /(\d+)\s*(?:anggota|members?|أعضاء|成员|成員|メンバー|구성원|สมาชิก|thành\s*viên|участник|miembros?|membres?|mitglieder)/i,
        
        // Format dengan bullet: "• 80 anggota"
        /[•·]\s*(\d+)\s*(?:anggota|members?|أعضاء|成员|成員|メンバー|구성원|สมาชิก|thành\s*viên|участник|miembros?|membres?|mitglieder)/i,
        
        // Format dengan separator: "anggota: 80"
        /(?:anggota|members?|أعضاء|成员|成員|メンバー|구성원|สมาชิก|thành\s*viên|участник|miembros?|membres?|mitglieder)\s*[:\-•]?\s*(\d+)/i
    ];
    
    // Cari member count
    for (let patternIndex = 0; patternIndex < memberPatterns.length; patternIndex++) {
        const pattern = memberPatterns[patternIndex];
        
        for (const line of lines) {
            const match = line.match(pattern);
            if (match) {
                const count = parseInt(match[1]);
                if (count >= 1 && count <= 1000000) {
                    memberCount = count;
                    console.log(`✅ Member count found: ${count}`);
                    console.log(`   Line: "${line}"`);
                    console.log(`   Pattern: ${patternIndex + 1}`);
                    break;
                }
            }
        }
        if (memberCount !== null) break;
    }
    
    // === STEP 2: DETEKSI NAMA GRUP ===
    console.log('\n🔍 STEP 2: Detecting group name...');
    
    // Keywords yang harus dihindari (info lines)
    const excludeKeywords = [
        'grup', 'group', 'anggota', 'members', 'member', 'chat', 'audio', 'tambah', 'add',
        'cari', 'search', 'notifikasi', 'notification', 'visibilitas', 'visibility',
        'pesan', 'message', 'enkripsi', 'encryption', 'dibuat', 'created', 'terakhir', 'last',
        'dilihat', 'seen', 'online', 'ketik', 'typing', 'info', 'deskripsi', 'description',
        'media', 'mati', 'mute', 'semua', 'all', 'tersimpan', 'saved',
        // Arabic
        'مجموعة', 'أعضاء', 'عضو', 'محادثة', 'صوت', 'إضافة', 'بحث', 'إشعار',
        // Chinese
        '群组', '群組', '成员', '成員', '聊天', '音频', '添加', '搜索', '通知',
        // Japanese
        'グループ', 'メンバー', 'チャット', 'オーディオ', '追加', '検索', '通知',
        // Korean
        '그룹', '구성원', '채팅', '오디오', '추가', '검색', '알림'
    ];
    
    const groupNameCandidates = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Skip baris kosong
        if (line.length === 0) continue;
        
        // Skip baris dengan exclude keywords
        const hasExcludeKeyword = excludeKeywords.some(keyword => 
            line.toLowerCase().includes(keyword.toLowerCase())
        );
        if (hasExcludeKeyword) {
            console.log(`⏭️ Skipped exclude: "${line}"`);
            continue;
        }
        
        // Skip baris dengan member patterns
        const hasMemberPattern = memberPatterns.some(pattern => pattern.test(line));
        if (hasMemberPattern) {
            console.log(`⏭️ Skipped member: "${line}"`);
            continue;
        }
        
        // Skip UI elements
        if (/[←→↓↑⬅➡⬇⬆📱💬🔍⚙️📞🎥🔊👥🔔⚡🗂️📋📄🔒]/.test(line)) {
            console.log(`⏭️ Skipped UI: "${line}"`);
            continue;
        }
        
        // Skip nomor telepon
        if (/^\+?\d{8,15}$/.test(line.replace(/[\s\-()]/g, ''))) {
            console.log(`⏭️ Skipped phone: "${line}"`);
            continue;
        }
        
        // Skip tanggal/waktu
        if (/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(line) || /\d{1,2}:\d{2}/.test(line)) {
            console.log(`⏭️ Skipped date/time: "${line}"`);
            continue;
        }
        
        // Scoring untuk kandidat nama grup
        let score = 0;
        
        // PRIORITAS TINGGI: Posisi di atas (nama grup selalu di atas di WhatsApp)
        if (i === 0) score += 100;
        if (i === 1) score += 80;
        if (i === 2) score += 60;
        if (i <= 4) score += 40;
        
        // Format scoring
        if (/^\d+$/.test(line)) score += 50; // Pure numbers like "292"
        if (/^[A-Za-z0-9\s\u0080-\uFFFF\-_.()]+$/.test(line)) score += 30; // Alphanumeric + unicode
        if (/[\u0080-\uFFFF]/.test(line)) score += 25; // Unicode (emojis, non-latin)
        if (/^[A-Za-z]/.test(line)) score += 20; // Starts with letter
        
        // Length scoring
        if (line.length >= 1 && line.length <= 50) score += 15;
        if (line.length >= 2 && line.length <= 30) score += 10;
        
        // Penalty untuk format tidak wajar
        if (line.length > 50) score -= 20;
        if (/[.,:;!?]{2,}/.test(line)) score -= 15;
        
        groupNameCandidates.push({ 
            line: line.trim(), 
            score: score, 
            index: i 
        });
        
        console.log(`📝 "${line}" → Score: ${score} (pos: ${i})`);
    }
    
    // Sort berdasarkan score tertinggi
    groupNameCandidates.sort((a, b) => b.score - a.score);
    
    if (groupNameCandidates.length > 0) {
        groupName = groupNameCandidates[0].line;
        console.log(`🎯 SELECTED: "${groupName}" (score: ${groupNameCandidates[0].score})`);
        
        console.log('🏆 Top candidates:');
        groupNameCandidates.slice(0, 3).forEach((c, i) => {
            console.log(`   ${i + 1}. "${c.line}" (${c.score})`);
        });
    }
    
    // === FALLBACK SYSTEMS ===
    
    // Fallback untuk member count
    if (memberCount === null) {
        console.log('\n🔄 Fallback: Looking for numbers...');
        const allNumbers = [];
        
        for (const line of lines) {
            const numbers = line.match(/\d+/g);
            if (numbers) {
                numbers.forEach(numStr => {
                    const num = parseInt(numStr);
                    if (num >= 2 && num <= 100000) {
                        allNumbers.push({ number: num, line: line });
                        console.log(`   Number: ${num} in "${line}"`);
                    }
                });
            }
        }
        
        if (allNumbers.length > 0) {
            // Pilih angka yang paling mungkin
            memberCount = allNumbers.length > 1 ? allNumbers[1].number : allNumbers[0].number;
            console.log(`🔄 Fallback member count: ${memberCount}`);
        }
    }
    
    // Fallback untuk group name
    if (!groupName && lines.length > 0) {
        console.log('\n🔄 Fallback: Using first substantial line...');
        for (const line of lines) {
            if (line.trim().length >= 1) {
                groupName = line.trim();
                console.log(`🔄 Fallback group name: "${groupName}"`);
                break;
            }
        }
    }
    
    const result = {
        groupName: groupName || 'Unknown Group',
        memberCount: memberCount || 0,
        success: groupName !== null && memberCount !== null
    };
    
    console.log('\n🎯 === FINAL RESULT ===');
    console.log(`   Group Name: "${result.groupName}"`);
    console.log(`   Member Count: ${result.memberCount}`);
    console.log(`   Success: ${result.success}`);
    console.log('========================\n');
    
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

// Fungsi update message yang sangat aman
async function safeUpdateMessage(chatId, messageId, groups, isProcessing = false) {
    try {
        let text = `🤖 **BOT REKAP GRUP - HASIL REAL TIME**\n\n`;
        
        if (isProcessing) {
            text += `⏳ **Sedang memproses foto...**\n\n`;
        } else {
            text += `✅ **Siap menerima foto berikutnya**\n\n`;
        }
        
        if (groups.length > 0) {
            text += `📊 **HASIL TERKINI (${groups.length} grup):**\n\n`;
            
            groups.forEach((group, index) => {
                text += `**${index + 1}.**\n`;
                text += `Nama Grup: ${group.name}\n`;
                text += `Anggota: ${group.members}\n\n`;
            });
            
            const memberCounts = groups.map(g => g.members);
            const total = groups.reduce((sum, g) => sum + g.members, 0);
            text += `🧮 **TOTAL SEMENTARA:**\n${memberCounts.join(' + ')} = ${total}\n\n`;
            text += `💡 Kirim foto lagi atau klik Selesai`;
        } else {
            text += `📊 **Belum ada grup terdeteksi**\n\n💡 Kirim foto screenshot grup WhatsApp`;
        }
        
        // Cek apakah konten sama dengan sebelumnya
        const session = userSessions.get(chatId);
        if (session && session.lastMessageContent === text) {
            console.log('⏭️ Skipping update - content unchanged');
            return messageId;
        }
        
        // Update last message content
        if (session) {
            session.lastMessageContent = text;
        }
        
        // Update message
        if (messageId) {
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: createKeyboard(groups.length > 0)
            });
            console.log('✅ Message updated successfully');
        } else {
            const newMsg = await bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: createKeyboard(groups.length > 0)
            });
            console.log('✅ New message sent');
            return newMsg.message_id;
        }
        
    } catch (error) {
        console.error('⚠️ Message update error:', error.message);
        
        // Fallback: kirim message baru
        try {
            const fallbackText = `🤖 **BOT REKAP GRUP**\n\n${groups.length > 0 ? `Grup terdeteksi: ${groups.length}\nTotal anggota: ${groups.reduce((sum, g) => sum + g.members, 0)}` : 'Memulai deteksi...'}\n\n💡 Kirim foto grup WhatsApp`;
            
            const newMsg = await bot.sendMessage(chatId, fallbackText, {
                parse_mode: 'Markdown',
                reply_markup: createKeyboard(groups.length > 0)
            });
            console.log('✅ Fallback message sent');
            return newMsg.message_id;
        } catch (fallbackError) {
            console.error('❌ Fallback message failed:', fallbackError.message);
            return null;
        }
    }
    
    return messageId;
}

// Fungsi proses foto batch
async function processBatchPhotos(userId, chatId) {
    const session = userSessions.get(userId);
    if (!session || session.isProcessing || session.photoQueue.length === 0) return;

    console.log(`🚀 Processing ${session.photoQueue.length} photos for user ${userId}`);
    session.isProcessing = true;
    
    // Inisialisasi processing message
    if (!session.processingMessageId) {
        try {
            const processingMsg = await bot.sendMessage(chatId, 
                '🤖 **BOT REKAP GRUP - HASIL REAL TIME**\n\n⏳ **Sedang memproses foto...**\n\n📊 **Belum ada grup terdeteksi**\n\n💡 Kirim foto screenshot grup WhatsApp', 
                { parse_mode: 'Markdown' }
            );
            session.processingMessageId = processingMsg.message_id;
        } catch (error) {
            console.error('❌ Failed to create processing message:', error.message);
        }
    }
    
    // Update status processing
    session.processingMessageId = await safeUpdateMessage(chatId, session.processingMessageId, session.groups, true);
    
    // Proses setiap foto
    const currentQueue = [...session.photoQueue];
    session.photoQueue = [];
    
    for (const photoData of currentQueue) {
        try {
            console.log(`📸 Processing photo ${photoData.order}: ${photoData.fileId}`);
            
            // Download foto
            const imagePath = await downloadPhoto(photoData.fileId);
            console.log(`✅ Downloaded: ${imagePath}`);
            
            // OCR
            const extractedText = await performStableOCR(imagePath);
            
            // Parse
            const groupInfo = parseWhatsAppGroup(extractedText);
            
            if (groupInfo.success && groupInfo.memberCount > 0) {
                session.addGroup(groupInfo.groupName, groupInfo.memberCount);
                
                console.log(`✅ Added group ${session.groups.length}: "${groupInfo.groupName}" - ${groupInfo.memberCount} members`);
                
                // Update hasil incremental
                session.processingMessageId = await safeUpdateMessage(chatId, session.processingMessageId, session.groups, true);
            } else {
                console.log(`⚠️ No valid data from photo ${photoData.order}`);
            }

            // Cleanup
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }

            // Delete user photo
            try {
                await bot.deleteMessage(chatId, photoData.messageId);
            } catch (error) {
                // Ignore delete errors
            }
            
        } catch (error) {
            console.error(`❌ Error processing photo ${photoData.order}:`, error.message);
        }
    }
    
    // Update final status
    session.processingMessageId = await safeUpdateMessage(chatId, session.processingMessageId, session.groups, false);
    session.isProcessing = false;
    
    console.log(`✅ Batch complete. Total groups: ${session.groups.length}`);
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

    console.log(`📥 Photo queued as #${photoOrder}. Queue: ${session.photoQueue.length}`);

    if (session.timer) {
        clearTimeout(session.timer);
    }

    session.timer = setTimeout(async () => {
        await processBatchPhotos(userId, chatId);
    }, 10000);

    console.log(`⏰ Timer set. Queue: ${session.photoQueue.length} photos`);
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

    const welcomeText = `🤖 **STABLE OCR BOT - NO ERRORS**

🎯 **Deteksi Akurat untuk WhatsApp Group**

✨ **Fitur:**
• Deteksi format: "292" → Nama Grup ✅
• Deteksi format: "Grup • 80 anggota" → 80 Anggota ✅
• Konfigurasi OCR stabil tanpa error
• Error handling sempurna
• Incremental results berurutan

📊 **Contoh Hasil:**
**1.**
Nama Grup: 292
Anggota: 80

**2.**
Nama Grup: Family Group
Anggota: 25

🧮 **TOTAL ANGGOTA:**
80 + 25 = 105

🚀 **Cara Pakai:**
1. Screenshot info grup WhatsApp
2. Kirim foto (bisa banyak)
3. Tunggu 10 detik untuk auto-process
4. Lihat hasil real-time

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

🔄 Status: ${session.isProcessing ? 'Processing' : 'Ready'}
📈 Total grup: ${session.groups.length}
👥 Total anggota: ${session.getTotalMembers()}
📸 Foto antrian: ${session.photoQueue.length}

${session.getFormattedResults()}`;

        await bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
    } else {
        await bot.sendMessage(chatId, '📊 **STATUS:** Belum ada rekap aktif.\n\nKirim foto grup untuk memulai!', { parse_mode: 'Markdown' });
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

// Error handlers yang sangat robust
bot.on('polling_error', (error) => {
    console.error('❌ Polling error:', error.code || error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
});

process.on('SIGINT', () => {
    console.log('🛑 Bot shutting down...');
    
    // Cleanup sessions
    for (const [userId, session] of userSessions) {
        if (session.timer) {
            clearTimeout(session.timer);
        }
    }
    
    bot.stopPolling();
    process.exit(0);
});

// Startup
console.log('🚀 STABLE OCR BOT STARTED - NO ERRORS!');
console.log('🎯 Optimized for WhatsApp Group Detection');
console.log('🛡️ Stable Language Config:', STABLE_OCR_LANGUAGES);
console.log('👥 Authorized Admins:', ADMIN_IDS);
console.log('📱 Ready for group screenshots!');
console.log('=====================================');
