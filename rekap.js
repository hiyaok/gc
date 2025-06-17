//
const TelegramBot = require('node-telegram-bot-api');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');
const https = require('https');
const FormData = require('form-data');

// Konfigurasi Bot
const BOT_TOKEN = '7782738957:AAE1hBtX3eIEop26IU07X_YSSaK-ki2RgNA';
const ADMIN_IDS = [5988451717, 1285724437];

// OCR Configuration - Multiple engines for reliability
const OCR_SPACE_API_KEY = 'K89821722488957';
const OCR_SPACE_URL = 'https://api.ocr.space/parse/image';

// Tesseract fallback configuration
const TESSERACT_LANGUAGES = 'eng+ind+ara+chi_sim+jpn+kor+tha+vie+rus+spa+fra+deu';

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

// Fungsi OCR.space dengan perbaikan FormData
async function performOCRSpaceFixed(imagePath) {
    return new Promise((resolve, reject) => {
        try {
            console.log('🔍 Starting fixed OCR.space API...');
            
            // Validasi file terlebih dahulu
            if (!fs.existsSync(imagePath)) {
                throw new Error('Image file not found');
            }
            
            const fileStats = fs.statSync(imagePath);
            console.log(`📁 File size: ${fileStats.size} bytes`);
            
            if (fileStats.size === 0) {
                throw new Error('Image file is empty');
            }
            
            if (fileStats.size > 10 * 1024 * 1024) { // 10MB limit
                throw new Error('Image file too large');
            }
            
            // Baca file menjadi buffer dulu
            const fileBuffer = fs.readFileSync(imagePath);
            console.log(`📦 File buffer size: ${fileBuffer.length} bytes`);
            
            // Create FormData dengan cara yang lebih robust
            const form = new FormData();
            form.append('file', fileBuffer, {
                filename: path.basename(imagePath),
                contentType: 'image/jpeg'
            });
            form.append('apikey', OCR_SPACE_API_KEY);
            form.append('language', 'eng');
            form.append('isOverlayRequired', 'false');
            form.append('detectOrientation', 'true');
            form.append('scale', 'true');
            form.append('OCREngine', '2');
            form.append('isTable', 'false');

            // Get form headers
            const formHeaders = form.getHeaders();
            console.log('📤 Form headers prepared');

            const options = {
                hostname: 'api.ocr.space',
                port: 443,
                path: '/parse/image',
                method: 'POST',
                headers: {
                    ...formHeaders,
                    'User-Agent': 'TelegramBot/2.0'
                },
                timeout: 45000 // 45 second timeout
            };

            console.log('🌐 Making request to OCR.space...');

            const req = https.request(options, (res) => {
                let data = '';
                
                console.log(`📡 Response status: ${res.statusCode}`);
                
                res.on('data', chunk => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    try {
                        console.log('📥 Response received, parsing...');
                        const result = JSON.parse(data);
                        
                        console.log('📄 OCR.space Response:', JSON.stringify(result, null, 2));
                        
                        if (result.ParsedResults && result.ParsedResults[0] && result.ParsedResults[0].ParsedText) {
                            const parsedText = result.ParsedResults[0].ParsedText.trim();
                            
                            console.log(`✅ OCR.space success! Text length: ${parsedText.length}`);
                            console.log('📄 Extracted Text:');
                            console.log('=' .repeat(60));
                            console.log(parsedText);
                            console.log('=' .repeat(60));
                            
                            resolve(parsedText);
                        } else if (result.ErrorMessage && result.ErrorMessage.length > 0) {
                            const errorMsg = Array.isArray(result.ErrorMessage) ? result.ErrorMessage.join(', ') : result.ErrorMessage;
                            console.error('❌ OCR.space API Error:', errorMsg);
                            reject(new Error(`OCR.space Error: ${errorMsg}`));
                        } else {
                            console.error('❌ OCR.space: No text found or unexpected response format');
                            reject(new Error('No text found in image or unexpected response'));
                        }
                    } catch (parseError) {
                        console.error('❌ JSON Parse Error:', parseError.message);
                        console.error('❌ Raw response:', data.substring(0, 500));
                        reject(new Error(`Parse error: ${parseError.message}`));
                    }
                });
            });

            req.on('error', (error) => {
                console.error('❌ OCR.space Request Error:', error.message);
                reject(new Error(`Request failed: ${error.message}`));
            });

            req.on('timeout', () => {
                console.error('❌ OCR.space Request Timeout');
                req.destroy();
                reject(new Error('Request timeout'));
            });

            // Pipe form data to request
            form.pipe(req);
            
        } catch (error) {
            console.error('❌ OCR.space Setup Error:', error.message);
            reject(error);
        }
    });
}

// Fungsi Tesseract sebagai fallback
async function performTesseractOCR(imagePath) {
    try {
        console.log('🔄 Fallback: Starting Tesseract OCR...');
        
        const { data: { text, confidence } } = await Tesseract.recognize(imagePath, TESSERACT_LANGUAGES, {
            logger: () => {}, // Silent
            tessedit_pageseg_mode: Tesseract.PSM.AUTO,
            tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY,
            preserve_interword_spaces: '1'
        });
        
        console.log(`✅ Tesseract completed with ${confidence.toFixed(1)}% confidence`);
        console.log('📄 Tesseract Text:');
        console.log('=' .repeat(60));
        console.log(text);
        console.log('=' .repeat(60));
        
        return text;
        
    } catch (error) {
        console.error('❌ Tesseract Error:', error.message);
        throw new Error(`Tesseract failed: ${error.message}`);
    }
}

// Fungsi OCR utama dengan multiple engines
async function performMultiEngineOCR(imagePath) {
    console.log('🚀 Starting Multi-Engine OCR...');
    
    // Try OCR.space first
    try {
        const ocrSpaceResult = await performOCRSpaceFixed(imagePath);
        console.log('✅ OCR.space succeeded');
        return ocrSpaceResult;
    } catch (ocrSpaceError) {
        console.log('⚠️ OCR.space failed, trying Tesseract fallback...');
        console.log('⚠️ OCR.space error:', ocrSpaceError.message);
        
        // Fallback to Tesseract
        try {
            const tesseractResult = await performTesseractOCR(imagePath);
            console.log('✅ Tesseract fallback succeeded');
            return tesseractResult;
        } catch (tesseractError) {
            console.error('❌ All OCR engines failed');
            throw new Error(`All OCR engines failed. OCR.space: ${ocrSpaceError.message}, Tesseract: ${tesseractError.message}`);
        }
    }
}

// Fungsi parsing yang sangat akurat untuk WhatsApp
function parseWhatsAppGroupUltimate(ocrText) {
    console.log('\n🎯 Ultimate WhatsApp Group Parsing...');
    
    // Clean dan split text
    const lines = ocrText
        .split(/[\n\r]+/)
        .map(line => line.trim())
        .filter(line => line.length > 0);
    
    console.log('📋 All Detected Lines:');
    lines.forEach((line, i) => console.log(`  ${i + 1}: "${line}"`));
    
    let groupName = null;
    let memberCount = null;
    
    // === STEP 1: DETEKSI JUMLAH ANGGOTA ===
    console.log('\n🔍 STEP 1: Ultimate Member Count Detection...');
    
    // Pattern ultra-comprehensive untuk semua format
    const memberPatterns = [
        // WhatsApp format: "Grup • 80 anggota"
        /(?:grup|group)\s*[•·∙◦▪▫]\s*(\d+)\s*(?:anggota|members?)/i,
        
        // Simple format: "80 anggota"
        /(\d+)\s*(?:anggota|members?)/i,
        
        // Bullet format: "• 80 anggota"
        /[•·∙◦▪▫]\s*(\d+)\s*(?:anggota|members?)/i,
        
        // Separated format: "anggota: 80"
        /(?:anggota|members?)\s*[:\-•]?\s*(\d+)/i,
        
        // Arabic
        /(?:مجموعة)\s*[•·∙◦▪▫]\s*(\d+)\s*(?:أعضاء)/i,
        /(\d+)\s*(?:أعضاء)/i,
        
        // Chinese
        /(?:群组|群組)\s*[•·∙◦▪▫]\s*(\d+)\s*(?:成员|成員)/i,
        /(\d+)\s*(?:成员|成員)/i,
        
        // Japanese
        /(?:グループ)\s*[•·∙◦▪▫]\s*(\d+)\s*(?:メンバー)/i,
        /(\d+)\s*(?:メンバー)/i,
        
        // Korean
        /(?:그룹)\s*[•·∙◦▪▫]\s*(\d+)\s*(?:구성원)/i,
        /(\d+)\s*(?:구성원)/i,
        
        // Generic patterns
        /[•·∙◦▪▫]\s*(\d+)/i,
        /(?:grup|group).*?(\d+)/i
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
                    console.log(`✅ Member count: ${count} from "${line}" (pattern ${patternIndex + 1})`);
                    break;
                }
            }
        }
        if (memberCount !== null) break;
    }
    
    // === STEP 2: DETEKSI NAMA GRUP ===
    console.log('\n🔍 STEP 2: Ultimate Group Name Detection...');
    
    // Extended exclude keywords
    const excludeKeywords = [
        'grup', 'group', 'anggota', 'members', 'member', 'chat', 'audio', 'tambah', 'add',
        'cari', 'search', 'notifikasi', 'notification', 'visibilitas', 'visibility',
        'pesan', 'message', 'enkripsi', 'encryption', 'dibuat', 'created', 'terakhir', 'last',
        'dilihat', 'seen', 'online', 'ketik', 'typing', 'info', 'deskripsi', 'description',
        'media', 'mati', 'mute', 'semua', 'all', 'tersimpan', 'saved', 'hapus', 'delete',
        'keluar', 'leave', 'admin', 'bergabung', 'joined', 'diundang', 'invited'
    ];
    
    const groupNameCandidates = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Skip baris kosong
        if (line.length === 0) continue;
        
        // Skip exclude keywords
        const hasExcludeKeyword = excludeKeywords.some(keyword => 
            line.toLowerCase().includes(keyword.toLowerCase())
        );
        if (hasExcludeKeyword) {
            console.log(`⏭️ Skipped exclude: "${line}"`);
            continue;
        }
        
        // Skip member patterns
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
        
        // Skip phone numbers, emails, URLs, dates
        if (/^\+?\d{8,15}$/.test(line.replace(/[\s\-()]/g, '')) ||
            /\S+@\S+\.\S+/.test(line) ||
            /https?:\/\/|www\.|\.com/.test(line) ||
            /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(line) ||
            /\d{1,2}:\d{2}/.test(line)) {
            console.log(`⏭️ Skipped special: "${line}"`);
            continue;
        }
        
        // Ultimate scoring
        let score = 0;
        
        // MEGA PRIORITY: Position scoring
        if (i === 0) score += 300;
        if (i === 1) score += 200;
        if (i === 2) score += 150;
        if (i <= 4) score += 100;
        if (i <= 6) score += 50;
        
        // Format scoring
        if (/^\d+$/.test(line)) score += 150; // Pure numbers like "292"
        if (/^[A-Za-z0-9\s\u0080-\uFFFF\-_.()]+$/.test(line)) score += 80;
        if (/[\u0080-\uFFFF]/.test(line)) score += 60; // Unicode
        if (/^[A-Z]/.test(line)) score += 40; // Capitalized
        if (/[0-9]/.test(line)) score += 30; // Contains numbers
        
        // Length scoring
        if (line.length >= 1 && line.length <= 50) score += 30;
        if (line.length >= 2 && line.length <= 30) score += 20;
        
        // Penalty
        if (line.length > 60) score -= 50;
        if (/[.,:;!?]{2,}/.test(line)) score -= 30;
        
        groupNameCandidates.push({ 
            line: line.trim(), 
            score: score, 
            index: i 
        });
        
        console.log(`📝 "${line}" → Score: ${score} (pos: ${i})`);
    }
    
    // Sort and select best
    groupNameCandidates.sort((a, b) => b.score - a.score);
    
    if (groupNameCandidates.length > 0) {
        groupName = groupNameCandidates[0].line;
        console.log(`🎯 SELECTED: "${groupName}" (score: ${groupNameCandidates[0].score})`);
    }
    
    // === FALLBACK SYSTEMS ===
    if (memberCount === null) {
        console.log('\n🔄 Fallback: Number search...');
        const allNumbers = [];
        
        for (const line of lines) {
            const numbers = line.match(/\d+/g);
            if (numbers) {
                numbers.forEach(numStr => {
                    const num = parseInt(numStr);
                    if (num >= 2 && num <= 100000) {
                        allNumbers.push(num);
                    }
                });
            }
        }
        
        if (allNumbers.length > 0) {
            memberCount = allNumbers.length > 1 ? allNumbers[1] : allNumbers[0];
            console.log(`🔄 Fallback member count: ${memberCount}`);
        }
    }
    
    if (!groupName && lines.length > 0) {
        groupName = lines[0].trim();
        console.log(`🔄 Fallback group name: "${groupName}"`);
    }
    
    const result = {
        groupName: groupName || 'Unknown Group',
        memberCount: memberCount || 0,
        success: groupName !== null && memberCount !== null
    };
    
    console.log('\n🎯 === ULTIMATE RESULT ===');
    console.log(`   Group Name: "${result.groupName}"`);
    console.log(`   Member Count: ${result.memberCount}`);
    console.log(`   Success: ${result.success}`);
    console.log('==========================\n');
    
    return result;
}

// Fungsi download foto dengan retry
async function downloadPhotoWithRetry(fileId, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`📥 Download attempt ${attempt}/${maxRetries} for ${fileId}`);
            
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
                        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                        return;
                    }
                    
                    response.pipe(file);
                    file.on('finish', () => {
                        file.close();
                        console.log(`✅ Download successful: ${localPath}`);
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
            console.log(`❌ Download attempt ${attempt} failed:`, error.message);
            if (attempt === maxRetries) {
                throw new Error(`Download failed after ${maxRetries} attempts: ${error.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
        }
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
async function ultraSafeUpdateMessage(chatId, messageId, groups, isProcessing = false) {
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
                console.log('✅ Message edited successfully');
                return messageId;
            } catch (editError) {
                console.log('⚠️ Edit failed, sending new message');
            }
        }
        
        // Send new message
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

// Fungsi proses foto batch
async function processBatchPhotos(userId, chatId) {
    const session = userSessions.get(userId);
    if (!session || session.isProcessing || session.photoQueue.length === 0) return;

    console.log(`🚀 Processing ${session.photoQueue.length} photos for user ${userId}`);
    session.isProcessing = true;
    
    // Initialize processing message
    if (!session.processingMessageId) {
        try {
            const processingMsg = await bot.sendMessage(chatId, 
                '🤖 **BOT REKAP GRUP - HASIL REAL TIME**\n\n⏳ **Sedang memproses foto...**\n\n📊 **Belum ada grup terdeteksi**\n\n💡 Kirim foto screenshot grup WhatsApp', 
                { parse_mode: 'Markdown' }
            );
            session.processingMessageId = processingMsg.message_id;
        } catch (error) {
            console.error('❌ Failed to create processing message');
        }
    }
    
    // Update status
    session.processingMessageId = await ultraSafeUpdateMessage(chatId, session.processingMessageId, session.groups, true);
    
    // Process photos
    const currentQueue = [...session.photoQueue];
    session.photoQueue = [];
    
    for (const photoData of currentQueue) {
        try {
            console.log(`📸 Processing photo ${photoData.order}/${currentQueue.length}`);
            
            // Download photo
            const imagePath = await downloadPhotoWithRetry(photoData.fileId);
            
            // Multi-engine OCR
            const extractedText = await performMultiEngineOCR(imagePath);
            
            // Parse
            const groupInfo = parseWhatsAppGroupUltimate(extractedText);
            
            if (groupInfo.success && groupInfo.memberCount > 0) {
                session.addGroup(groupInfo.groupName, groupInfo.memberCount);
                
                console.log(`✅ Added: "${groupInfo.groupName}" - ${groupInfo.memberCount} members`);
                
                // Update incremental
                session.processingMessageId = await ultraSafeUpdateMessage(chatId, session.processingMessageId, session.groups, true);
            } else {
                console.log(`⚠️ No valid data from photo ${photoData.order}`);
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
            } catch (deleteError) {
                // Ignore delete errors
            }
            
        } catch (error) {
            console.error(`❌ Error processing photo ${photoData.order}:`, error.message);
        }
    }
    
    // Final update
    session.processingMessageId = await ultraSafeUpdateMessage(chatId, session.processingMessageId, session.groups, false);
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

    console.log(`📥 Photo queued #${photoOrder}. Queue: ${session.photoQueue.length}`);

    if (session.timer) {
        clearTimeout(session.timer);
    }

    session.timer = setTimeout(async () => {
        await processBatchPhotos(userId, chatId);
    }, 10000);

    console.log(`⏰ Timer set. Queue: ${session.photoQueue.length}`);
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

    const welcomeText = `🤖 **FIXED ROBUST OCR BOT**

🎯 **Multi-Engine OCR untuk Akurasi Maksimal**

✨ **Teknologi:**
• OCR.space API (Primary)
• Tesseract OCR (Fallback)
• Advanced error handling
• Fixed FormData upload
• Retry mechanisms

📊 **Deteksi Perfect:**
• Format: "292" → Nama Grup ✅
• Format: "Grup • 80 anggota" → 80 Anggota ✅
• Support semua bahasa
• Zero upload errors
• Incremental results

🚀 **Cara Pakai:**
1. Screenshot info grup WhatsApp
2. Kirim foto (bisa banyak)
3. Tunggu 10 detik auto-process
4. Lihat hasil real-time
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

🔄 Status: ${session.isProcessing ? 'Processing' : 'Ready'}
📈 Total grup: ${session.groups.length}
👥 Total anggota: ${session.getTotalMembers()}
📸 Antrian: ${session.photoQueue.length}

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
        await bot.sendMessage(chatId, '🔄 **Data direset!**\n\nKirim foto untuk memulai rekap baru.', { parse_mode: 'Markdown' });
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
    console.log('🛑 Bot shutting down...');
    
    // Cleanup
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
        }
    } catch (cleanupError) {
        console.log('⚠️ Cleanup warning:', cleanupError.message);
    }
    
    bot.stopPolling();
    process.exit(0);
});

// Startup
console.log('🚀 FIXED ROBUST OCR BOT STARTED!');
console.log('🎯 Multi-Engine: OCR.space + Tesseract');
console.log('🛡️ Fixed FormData upload issues');
console.log('🔑 OCR.space API Key:', OCR_SPACE_API_KEY ? `${OCR_SPACE_API_KEY.slice(0, 8)}...` : 'NOT SET');
console.log('👥 Authorized Admins:', ADMIN_IDS);
console.log('📱 Ready with enhanced error handling!');
console.log('=====================================');
