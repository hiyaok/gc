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
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}

// Fungsi preprocessing gambar yang aman dengan error handling
async function safeImagePreprocessing(inputPath) {
    try {
        const outputPath = inputPath.replace('.jpg', '_processed.jpg');
        
        // Cek ukuran gambar dulu
        const metadata = await sharp(inputPath).metadata();
        console.log(`📐 Image size: ${metadata.width}x${metadata.height}`);
        
        // Jika gambar terlalu kecil, skip preprocessing
        if (metadata.width < 50 || metadata.height < 50) {
            console.log('⚠️ Image too small, using original');
            return inputPath;
        }
        
        // Target size untuk OCR optimal
        const targetWidth = Math.max(1600, metadata.width);
        const targetHeight = Math.max(900, metadata.height);
        
        await sharp(inputPath)
            .resize(targetWidth, targetHeight, { 
                fit: 'inside',
                withoutEnlargement: false,
                kernel: sharp.kernel.lanczos3
            })
            .normalize()
            .sharpen({ sigma: 1.0, flat: 1, jagged: 1.5 })
            .gamma(1.1)
            .modulate({
                brightness: 1.1,
                saturation: 0.8,
                lightness: 1.05
            })
            .jpeg({ quality: 95, progressive: false })
            .toFile(outputPath);
        
        console.log('✅ Image preprocessing completed');
        return outputPath;
        
    } catch (error) {
        console.error('⚠️ Preprocessing failed, using original:', error.message);
        return inputPath;
    }
}

// Fungsi OCR dengan konfigurasi optimal
async function performOCR(imagePath) {
    try {
        console.log('🔍 Starting OCR process...');
        
        const processedPath = await safeImagePreprocessing(imagePath);
        
        // Konfigurasi OCR untuk akurasi maksimal
        const ocrConfig = {
            lang: 'eng+ind+ara+chi_sim+chi_tra+jpn+kor+tha+vie+rus+spa+fra+deu+ita+por+nld+hin+ben+tam+tel+tur+heb',
            tessedit_pageseg_mode: Tesseract.PSM.AUTO,
            tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY,
            preserve_interword_spaces: '1',
            user_defined_dpi: '300',
            logger: () => {} // Silent
        };
        
        const { data: { text, confidence } } = await Tesseract.recognize(processedPath, ocrConfig.lang, ocrConfig);
        
        console.log(`✅ OCR completed with confidence: ${confidence.toFixed(1)}%`);
        console.log('📄 OCR Text Output:');
        console.log('=' .repeat(60));
        console.log(text);
        console.log('=' .repeat(60));
        
        // Cleanup processed file
        if (fs.existsSync(processedPath) && processedPath !== imagePath) {
            fs.unlinkSync(processedPath);
        }
        
        return text;
        
    } catch (error) {
        console.error('❌ OCR Error:', error.message);
        throw new Error(`OCR failed: ${error.message}`);
    }
}

// Fungsi parsing yang sangat spesifik untuk format WhatsApp
function parseWhatsAppGroup(ocrText) {
    console.log('\n🎯 Starting WhatsApp-specific parsing...');
    
    // Clean dan split text
    const lines = ocrText.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
    
    console.log('📋 Detected lines:');
    lines.forEach((line, i) => console.log(`  ${i + 1}: "${line}"`));
    
    let groupName = null;
    let memberCount = null;
    
    // === STEP 1: DETEKSI JUMLAH ANGGOTA ===
    console.log('\n🔍 STEP 1: Detecting member count...');
    
    // Pattern super comprehensive untuk semua format anggota
    const memberPatterns = [
        // Format: "Grup • 80 anggota" atau "Group • 80 members"
        /(?:grup|group|مجموعة|群组|群組|グループ|그룹|กลุ่ม|nhóm|группа|grupo|groupe|gruppe|समूह|grup)\s*[•·]\s*(\d+)\s*(?:anggota|members?|أعضاء|成员|成員|メンバー|구성원|สมาชิก|thành\s*viên|участник|miembros?|membres?|mitglieder|सदस्य|üye)/i,
        
        // Format: "80 anggota" atau "80 members"
        /(\d+)\s*(?:anggota|members?|أعضاء|成员|成員|メンバー|구성원|สมาชิก|thành\s*viên|участник|miembros?|membres?|mitglieder|सदस्य|üye)/i,
        
        // Format: "anggota: 80" atau "members: 80"
        /(?:anggota|members?|أعضاء|成员|成員|メンバー|구성원|สมาชิก|thành\s*viên|участник|miembros?|membres?|mitglieder|सदस्य|üye)\s*[:\-•]?\s*(\d+)/i,
        
        // Format dengan bullet point
        /•\s*(\d+)\s*(?:anggota|members?|أعضاء|成员|成員|メンバー|구성원|สมาชิก|thành\s*viên|участник|miembros?|membres?|mitglieder|सदस्य|üye)/i,
        
        // Format reversed
        /(?:anggota|members?|أعضاء|成员|成員|メンバー|구성원|สมาชิก|thành\s*viên|участник|miembros?|membres?|mitglieder|सदस्य|üye)\s*(\d+)/i
    ];
    
    // Cari member count dengan prioritas pattern
    for (let patternIndex = 0; patternIndex < memberPatterns.length; patternIndex++) {
        const pattern = memberPatterns[patternIndex];
        
        for (const line of lines) {
            const match = line.match(pattern);
            if (match) {
                const count = parseInt(match[1]);
                if (count >= 1 && count <= 1000000) {
                    memberCount = count;
                    console.log(`✅ Found member count: ${count}`);
                    console.log(`   From line: "${line}"`);
                    console.log(`   Using pattern ${patternIndex + 1}`);
                    break;
                }
            }
        }
        if (memberCount !== null) break;
    }
    
    // === STEP 2: DETEKSI NAMA GRUP ===
    console.log('\n🔍 STEP 2: Detecting group name...');
    
    // Keywords yang menandakan BUKAN nama grup
    const excludeKeywords = [
        // Indonesia
        'grup', 'anggota', 'chat', 'audio', 'tambah', 'cari', 'notifikasi', 'visibilitas', 
        'pesan', 'enkripsi', 'dibuat', 'terakhir', 'dilihat', 'online', 'ketik', 'info', 
        'deskripsi', 'media', 'mati', 'semua', 'tersimpan',
        
        // English
        'group', 'members', 'member', 'chat', 'audio', 'add', 'search', 'notification', 
        'visibility', 'message', 'encryption', 'created', 'last', 'seen', 'online', 
        'typing', 'info', 'description', 'media', 'mute', 'all', 'saved',
        
        // Arabic
        'مجموعة', 'أعضاء', 'عضو', 'محادثة', 'صوت', 'إضافة', 'بحث', 'إشعار', 'رؤية', 
        'رسالة', 'تشفير', 'آخر', 'متصل', 'معلومات', 'وصف',
        
        // Chinese
        '群组', '群組', '成员', '成員', '聊天', '音频', '添加', '搜索', '通知', '可见性', 
        '消息', '加密', '最后', '在线', '信息', '描述',
        
        // Japanese
        'グループ', 'メンバー', 'チャット', 'オーディオ', '追加', '検索', '通知', '表示', 
        'メッセージ', '暗号化', '最後', 'オンライン', '情報', '説明',
        
        // Korean
        '그룹', '구성원', '채팅', '오디오', '추가', '검색', '알림', '표시', '메시지', 
        '암호화', '마지막', '온라인', '정보', '설명'
    ];
    
    const groupNameCandidates = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Skip baris kosong
        if (line.length === 0) continue;
        
        // Skip baris yang mengandung exclude keywords
        const hasExcludeKeyword = excludeKeywords.some(keyword => 
            line.toLowerCase().includes(keyword.toLowerCase())
        );
        if (hasExcludeKeyword) {
            console.log(`⏭️ Skipped exclude line: "${line}"`);
            continue;
        }
        
        // Skip baris yang mengandung member patterns
        const hasMemberPattern = memberPatterns.some(pattern => pattern.test(line));
        if (hasMemberPattern) {
            console.log(`⏭️ Skipped member line: "${line}"`);
            continue;
        }
        
        // Skip UI elements dan symbols
        if (/[←→↓↑⬅➡⬇⬆📱💬🔍⚙️📞🎥🔊👥🔔⚡🗂️📋📄🔒]/.test(line)) {
            console.log(`⏭️ Skipped UI line: "${line}"`);
            continue;
        }
        
        // Skip nomor telepon
        if (/^\+?\d{8,15}$/.test(line.replace(/[\s\-()]/g, ''))) {
            console.log(`⏭️ Skipped phone: "${line}"`);
            continue;
        }
        
        // Skip tanggal/waktu format
        if (/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(line) || /\d{1,2}:\d{2}/.test(line)) {
            console.log(`⏭️ Skipped date/time: "${line}"`);
            continue;
        }
        
        // Skip single character atau terlalu pendek untuk nama grup
        if (line.length < 1) continue;
        
        // Hitung score untuk kandidat nama grup
        let score = 0;
        
        // SUPER HIGH PRIORITY: Posisi di bagian atas (nama grup selalu di atas)
        if (i === 0) score += 100;
        if (i === 1) score += 80;
        if (i === 2) score += 60;
        if (i <= 4) score += 40;
        if (i <= 6) score += 20;
        
        // Format scoring
        if (/^\d+$/.test(line)) score += 50; // Pure numbers like "292"
        if (/^[A-Za-z0-9\s\u0080-\uFFFF\-_.()]+$/.test(line)) score += 30; // Alphanumeric + unicode
        if (/[\u0080-\uFFFF]/.test(line)) score += 25; // Unicode characters (emojis, non-latin)
        if (/^[A-Za-z]/.test(line)) score += 20; // Starts with letter
        
        // Length scoring
        if (line.length >= 1 && line.length <= 50) score += 15;
        if (line.length >= 2 && line.length <= 30) score += 10;
        
        // Penalty untuk format yang tidak wajar
        if (line.length > 50) score -= 20;
        if (/[.,:;!?]{2,}/.test(line)) score -= 15;
        if (/^\s+$/.test(line)) score -= 100;
        
        groupNameCandidates.push({ 
            line: line.trim(), 
            score: score, 
            index: i 
        });
        
        console.log(`📝 Candidate: "${line}" → Score: ${score} (position: ${i})`);
    }
    
    // Sort berdasarkan score tertinggi
    groupNameCandidates.sort((a, b) => b.score - a.score);
    
    if (groupNameCandidates.length > 0) {
        groupName = groupNameCandidates[0].line;
        console.log(`🎯 SELECTED GROUP NAME: "${groupName}"`);
        console.log(`   Score: ${groupNameCandidates[0].score}`);
        console.log(`   Position: ${groupNameCandidates[0].index}`);
        
        console.log('\n🏆 Top 3 candidates:');
        groupNameCandidates.slice(0, 3).forEach((c, i) => {
            console.log(`   ${i + 1}. "${c.line}" (score: ${c.score}, pos: ${c.index})`);
        });
    }
    
    // === FALLBACK SYSTEMS ===
    
    // Fallback untuk member count
    if (memberCount === null) {
        console.log('\n🔄 FALLBACK: Searching for any reasonable numbers...');
        const allNumbers = [];
        
        for (const line of lines) {
            const numbers = line.match(/\d+/g);
            if (numbers) {
                numbers.forEach(numStr => {
                    const num = parseInt(numStr);
                    if (num >= 2 && num <= 100000) {
                        allNumbers.push({ number: num, line: line });
                        console.log(`   Found number: ${num} in "${line}"`);
                    }
                });
            }
        }
        
        if (allNumbers.length > 0) {
            // Pilih angka yang paling mungkin (biasanya bukan yang pertama jika itu nama grup)
            memberCount = allNumbers.length > 1 ? allNumbers[1].number : allNumbers[0].number;
            console.log(`🔄 Fallback member count: ${memberCount}`);
        }
    }
    
    // Fallback untuk group name
    if (!groupName && lines.length > 0) {
        console.log('\n🔄 FALLBACK: Using first substantial line...');
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
    
    console.log('\n🎯 === FINAL PARSING RESULT ===');
    console.log(`   Group Name: "${result.groupName}"`);
    console.log(`   Member Count: ${result.memberCount}`);
    console.log(`   Success: ${result.success}`);
    console.log('=================================\n');
    
    return result;
}

// Fungsi download foto dengan error handling
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

// Fungsi untuk membuat keyboard dengan error handling
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

// Fungsi update message dengan error handling yang robust
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
        
        // Cek apakah message ID masih valid
        if (messageId) {
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: createKeyboard(groups.length > 0)
            });
        } else {
            // Jika message ID tidak valid, kirim message baru
            const newMsg = await bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: createKeyboard(groups.length > 0)
            });
            return newMsg.message_id;
        }
        
    } catch (error) {
        console.error('⚠️ Message update error:', error.message);
        
        // Jika edit gagal, coba kirim message baru
        try {
            const newMsg = await bot.sendMessage(chatId, 
                `🤖 **BOT REKAP GRUP**\n\n${groups.length > 0 ? `Grup terdeteksi: ${groups.length}` : 'Memulai deteksi...'}\n\n💡 Kirim foto grup WhatsApp`, 
                {
                    parse_mode: 'Markdown',
                    reply_markup: createKeyboard(groups.length > 0)
                }
            );
            return newMsg.message_id;
        } catch (fallbackError) {
            console.error('❌ Fallback message send failed:', fallbackError.message);
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
    
    // Proses setiap foto secara berurutan
    const currentQueue = [...session.photoQueue];
    session.photoQueue = [];
    
    for (const photoData of currentQueue) {
        try {
            console.log(`📸 Processing photo ${photoData.order}: ${photoData.fileId}`);
            
            // Download foto
            const imagePath = await downloadPhoto(photoData.fileId);
            console.log(`✅ Photo downloaded: ${imagePath}`);
            
            // Perform OCR
            const extractedText = await performOCR(imagePath);
            
            // Parse hasil OCR
            const groupInfo = parseWhatsAppGroup(extractedText);
            
            if (groupInfo.success && groupInfo.memberCount > 0) {
                // Tambah ke session
                session.addGroup(groupInfo.groupName, groupInfo.memberCount);
                
                console.log(`✅ Added group ${session.groups.length}: "${groupInfo.groupName}" - ${groupInfo.memberCount} members`);
                
                // Update hasil incremental
                session.processingMessageId = await safeUpdateMessage(chatId, session.processingMessageId, session.groups, true);
            } else {
                console.log(`⚠️ No valid data extracted from photo ${photoData.order}`);
            }

            // Cleanup
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }

            // Delete user photo
            try {
                await bot.deleteMessage(chatId, photoData.messageId);
            } catch (error) {
                console.error('⚠️ Could not delete photo message:', error.message);
            }
            
        } catch (error) {
            console.error(`❌ Error processing photo ${photoData.order}:`, error.message);
        }
    }
    
    // Update final status
    session.processingMessageId = await safeUpdateMessage(chatId, session.processingMessageId, session.groups, false);
    session.isProcessing = false;
    
    console.log(`✅ Batch processing complete. Total groups: ${session.groups.length}`);
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

    console.log(`📥 Photo queued as #${photoOrder}. Queue size: ${session.photoQueue.length}`);

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
        console.error('⚠️ Callback query error:', error.message);
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

    const welcomeText = `🤖 **SUPER ACCURATE OCR BOT**

🎯 **Khusus untuk WhatsApp Group Detection**

✨ **Fitur Unggulan:**
• Deteksi akurat format: "292" → Nama Grup
• Deteksi akurat format: "Grup • 80 anggota" → 80 Anggota  
• Support semua bahasa dan ukuran gambar
• Error handling sempurna
• Hasil berurutan sesuai foto dikirim
• Incremental results (tidak reset)

📋 **Format Output:**
**1.**
Nama Grup: 292
Anggota: 80

**2.**
Nama Grup: [nama grup kedua]
Anggota: [jumlah anggota]

🧮 **TOTAL ANGGOTA:**
80 + 25 = 105

🚀 **Cara Pakai:**
1. Screenshot halaman info grup WhatsApp
2. Kirim foto (bisa banyak sekaligus)
3. Bot tunggu 10 detik lalu proses otomatis
4. Lihat hasil real-time yang terus bertambah

💡 Kirim foto pertama untuk memulai!`;

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

🔄 Status: ${session.isProcessing ? 'Sedang memproses' : 'Standby'}
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

// Error handlers dengan logging yang lebih baik
bot.on('polling_error', (error) => {
    console.error('❌ Polling error:', error.code, error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
});

process.on('SIGINT', () => {
    console.log('🛑 Bot shutting down gracefully...');
    
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
console.log('🚀 SUPER ACCURATE OCR BOT STARTED!');
console.log('🎯 Specialized for WhatsApp Group Detection');
console.log('🛡️ Enhanced Error Handling & Image Processing');
console.log('👥 Authorized Admins:', ADMIN_IDS);
console.log('📱 Ready to process group screenshots!');
console.log('=======================================');
