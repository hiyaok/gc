//
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const https = require('https');
const FormData = require('form-data');

// Konfigurasi Bot
const BOT_TOKEN = '7782738957:AAE1hBtX3eIEop26IU07X_YSSaK-ki2RgNA';
const ADMIN_IDS = [5988451717, 1285724437];

// OCR.space API Configuration
const OCR_SPACE_API_KEY = 'K89821722488957';
const OCR_SPACE_URL = 'https://api.ocr.space/parse/image';

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
        this.messageContentHash = '';
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
        this.messageContentHash = '';
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}

// Fungsi OCR menggunakan OCR.space API
async function performOCRSpace(imagePath) {
    return new Promise((resolve, reject) => {
        try {
            console.log('🔍 Starting OCR.space API...');
            
            const form = new FormData();
            form.append('file', fs.createReadStream(imagePath));
            form.append('apikey', OCR_SPACE_API_KEY);
            form.append('language', 'eng');
            form.append('isOverlayRequired', 'false');
            form.append('detectOrientation', 'true');
            form.append('scale', 'true');
            form.append('OCREngine', '2'); // Engine 2 untuk layout kompleks
            form.append('isTable', 'false');

            const options = {
                hostname: 'api.ocr.space',
                port: 443,
                path: '/parse/image',
                method: 'POST',
                headers: {
                    ...form.getHeaders(),
                    'User-Agent': 'TelegramBot/1.0'
                },
                timeout: 30000
            };

            const req = https.request(options, (res) => {
                let data = '';
                
                res.on('data', chunk => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        
                        console.log('📄 OCR.space Response:', JSON.stringify(result, null, 2));
                        
                        if (result.ParsedResults && result.ParsedResults[0]) {
                            const parsedText = result.ParsedResults[0].ParsedText;
                            const confidence = result.ParsedResults[0].TextOverlay ? 
                                result.ParsedResults[0].TextOverlay.HasOverlay : 'N/A';
                            
                            console.log(`✅ OCR.space completed successfully`);
                            console.log('📄 Extracted Text:');
                            console.log('=' .repeat(60));
                            console.log(parsedText);
                            console.log('=' .repeat(60));
                            
                            resolve(parsedText);
                        } else if (result.ErrorMessage) {
                            console.error('❌ OCR.space Error:', result.ErrorMessage);
                            reject(new Error(`OCR.space Error: ${result.ErrorMessage}`));
                        } else {
                            console.error('❌ OCR.space: No text found');
                            reject(new Error('No text found in image'));
                        }
                    } catch (parseError) {
                        console.error('❌ JSON Parse Error:', parseError.message);
                        console.error('Raw response:', data);
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

            form.pipe(req);
            
        } catch (error) {
            console.error('❌ OCR.space Setup Error:', error.message);
            reject(error);
        }
    });
}

// Fungsi parsing yang sangat akurat untuk WhatsApp dengan OCR.space
function parseWhatsAppGroupAdvanced(ocrText) {
    console.log('\n🎯 Advanced WhatsApp Group Parsing...');
    
    // Clean dan split text dengan berbagai separator
    const lines = ocrText
        .split(/[\n\r]+/)
        .map(line => line.trim())
        .filter(line => line.length > 0);
    
    console.log('📋 Detected Lines:');
    lines.forEach((line, i) => console.log(`  ${i + 1}: "${line}"`));
    
    let groupName = null;
    let memberCount = null;
    
    // === STEP 1: DETEKSI JUMLAH ANGGOTA ===
    console.log('\n🔍 STEP 1: Advanced Member Count Detection...');
    
    // Pattern sangat comprehensive untuk semua format anggota
    const memberPatterns = [
        // WhatsApp Indonesia: "Grup • 80 anggota"
        /(?:grup|group)\s*[•·∙◦▪▫]\s*(\d+)\s*anggota/i,
        
        // WhatsApp English: "Group • 80 members"
        /(?:grup|group)\s*[•·∙◦▪▫]\s*(\d+)\s*members?/i,
        
        // Format sederhana: "80 anggota" atau "80 members"
        /(\d+)\s*(?:anggota|members?)/i,
        
        // Format dengan bullet: "• 80 anggota"
        /[•·∙◦▪▫]\s*(\d+)\s*(?:anggota|members?)/i,
        
        // Format dengan separator: "anggota: 80"
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
        
        // Generic patterns with bullets
        /[•·∙◦▪▫]\s*(\d+)/i,
        
        // Numbers near group-related words
        /(?:grup|group|مجموعة|群组|群組|グループ|그룹|กลุ่ม|nhóm|группа|grupo|groupe|gruppe).*?(\d+)/i
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
                    console.log(`✅ Member count found: ${count}`);
                    console.log(`   From line: "${line}"`);
                    console.log(`   Pattern #${patternIndex + 1}`);
                    break;
                }
            }
        }
        if (memberCount !== null) break;
    }
    
    // === STEP 2: DETEKSI NAMA GRUP ===
    console.log('\n🔍 STEP 2: Advanced Group Name Detection...');
    
    // Extended exclude keywords
    const excludeKeywords = [
        // Indonesia
        'grup', 'anggota', 'chat', 'audio', 'tambah', 'cari', 'notifikasi', 'visibilitas', 
        'pesan', 'enkripsi', 'dibuat', 'terakhir', 'dilihat', 'online', 'ketik', 'info', 
        'deskripsi', 'media', 'mati', 'semua', 'tersimpan', 'hapus', 'keluar', 'admin',
        'bergabung', 'diundang', 'blokir', 'laporkan', 'salin', 'bagikan', 'unduh',
        
        // English
        'group', 'members', 'member', 'chat', 'audio', 'add', 'search', 'notification', 
        'visibility', 'message', 'encryption', 'created', 'last', 'seen', 'online', 
        'typing', 'info', 'description', 'media', 'mute', 'all', 'saved', 'delete',
        'leave', 'admin', 'joined', 'invited', 'block', 'report', 'copy', 'share', 'download',
        
        // Common UI terms
        'back', 'menu', 'settings', 'profile', 'contact', 'call', 'video', 'voice',
        'camera', 'gallery', 'document', 'location', 'status', 'archive', 'pin',
        'forward', 'reply', 'quote', 'edit', 'starred', 'clear', 'export'
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
        
        // Skip UI elements dan symbols
        if (/[←→↓↑⬅➡⬇⬆📱💬🔍⚙️📞🎥🔊👥🔔⚡🗂️📋📄🔒💭🎤📷📁🌐⭐❤️👍]/.test(line)) {
            console.log(`⏭️ Skipped UI: "${line}"`);
            continue;
        }
        
        // Skip nomor telepon
        if (/^\+?\d{8,15}$/.test(line.replace(/[\s\-()]/g, ''))) {
            console.log(`⏭️ Skipped phone: "${line}"`);
            continue;
        }
        
        // Skip email addresses
        if (/\S+@\S+\.\S+/.test(line)) {
            console.log(`⏭️ Skipped email: "${line}"`);
            continue;
        }
        
        // Skip tanggal/waktu format
        if (/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(line) || /\d{1,2}:\d{2}/.test(line)) {
            console.log(`⏭️ Skipped date/time: "${line}"`);
            continue;
        }
        
        // Skip URL patterns
        if (/https?:\/\/|www\.|\.com|\.org|\.net/.test(line)) {
            console.log(`⏭️ Skipped URL: "${line}"`);
            continue;
        }
        
        // Skip single characters atau sangat pendek
        if (line.length < 1) continue;
        
        // Advanced scoring untuk kandidat nama grup
        let score = 0;
        
        // ULTRA HIGH PRIORITY: Posisi di bagian atas
        if (i === 0) score += 200;
        if (i === 1) score += 150;
        if (i === 2) score += 100;
        if (i <= 4) score += 50;
        if (i <= 6) score += 25;
        
        // Format scoring yang comprehensive
        if (/^\d+$/.test(line)) score += 100; // Pure numbers like "292"
        if (/^[A-Za-z0-9\s\u0080-\uFFFF\-_.()]+$/.test(line)) score += 60; // Alphanumeric + unicode
        if (/[\u0080-\uFFFF]/.test(line)) score += 40; // Unicode characters
        if (/^[A-Za-z]/.test(line)) score += 30; // Starts with letter
        if (/[0-9]/.test(line)) score += 20; // Contains numbers
        
        // Length scoring
        if (line.length >= 1 && line.length <= 50) score += 25;
        if (line.length >= 2 && line.length <= 30) score += 15;
        if (line.length >= 3 && line.length <= 20) score += 10;
        
        // Penalty untuk format yang tidak wajar
        if (line.length > 60) score -= 30;
        if (/[.,:;!?]{2,}/.test(line)) score -= 20;
        if (/^\s*$/.test(line)) score -= 200;
        if (line.split(' ').length > 10) score -= 25; // Too many words
        
        // Bonus untuk format yang sering digunakan sebagai nama grup
        if (/^[A-Z][a-zA-Z0-9\s]*$/.test(line)) score += 15; // Capitalized
        if (/family|keluarga|office|kantor|team|tim|friends|teman/i.test(line)) score += 20; // Common group types
        
        groupNameCandidates.push({ 
            line: line.trim(), 
            score: score, 
            index: i 
        });
        
        console.log(`📝 Candidate: "${line}" → Score: ${score} (pos: ${i})`);
    }
    
    // Sort berdasarkan score tertinggi
    groupNameCandidates.sort((a, b) => b.score - a.score);
    
    if (groupNameCandidates.length > 0) {
        groupName = groupNameCandidates[0].line;
        console.log(`🎯 SELECTED GROUP NAME: "${groupName}"`);
        console.log(`   Score: ${groupNameCandidates[0].score}`);
        console.log(`   Position: ${groupNameCandidates[0].index}`);
        
        console.log('\n🏆 Top 5 candidates:');
        groupNameCandidates.slice(0, 5).forEach((c, i) => {
            console.log(`   ${i + 1}. "${c.line}" (score: ${c.score}, pos: ${c.index})`);
        });
    }
    
    // === ADVANCED FALLBACK SYSTEMS ===
    
    // Fallback untuk member count
    if (memberCount === null) {
        console.log('\n🔄 Advanced Fallback: Searching for reasonable numbers...');
        const numberCandidates = [];
        
        for (const line of lines) {
            const numbers = line.match(/\d+/g);
            if (numbers) {
                numbers.forEach(numStr => {
                    const num = parseInt(numStr);
                    if (num >= 2 && num <= 100000) {
                        // Calculate score based on context
                        let numScore = 0;
                        
                        // Higher score if near group-related words
                        if (/(?:grup|group|anggota|member)/i.test(line)) numScore += 50;
                        if (/[•·∙◦▪▫]/.test(line)) numScore += 30;
                        
                        // Lower score for very large numbers (likely IDs)
                        if (num > 10000) numScore -= 20;
                        if (num < 5) numScore -= 10;
                        
                        numberCandidates.push({ 
                            number: num, 
                            line: line, 
                            score: numScore 
                        });
                        
                        console.log(`   Number: ${num} in "${line}" (score: ${numScore})`);
                    }
                });
            }
        }
        
        if (numberCandidates.length > 0) {
            // Sort by score and pick the best
            numberCandidates.sort((a, b) => b.score - a.score);
            memberCount = numberCandidates[0].number;
            console.log(`🔄 Fallback member count: ${memberCount} (score: ${numberCandidates[0].score})`);
        }
    }
    
    // Advanced fallback untuk group name
    if (!groupName && lines.length > 0) {
        console.log('\n🔄 Advanced Fallback: Finding best substantial line...');
        
        const fallbackCandidates = [];
        
        for (let i = 0; i < Math.min(lines.length, 5); i++) {
            const line = lines[i];
            if (line.trim().length >= 1) {
                let fallbackScore = 0;
                
                // Prioritize top lines
                fallbackScore += (5 - i) * 10;
                
                // Prefer shorter, cleaner lines
                if (line.length <= 30) fallbackScore += 15;
                if (line.length <= 20) fallbackScore += 10;
                
                // Avoid lines with common words
                if (!/(?:grup|group|anggota|member|chat|info)/i.test(line)) fallbackScore += 20;
                
                fallbackCandidates.push({
                    line: line.trim(),
                    score: fallbackScore,
                    index: i
                });
            }
        }
        
        if (fallbackCandidates.length > 0) {
            fallbackCandidates.sort((a, b) => b.score - a.score);
            groupName = fallbackCandidates[0].line;
            console.log(`🔄 Fallback group name: "${groupName}" (score: ${fallbackCandidates[0].score})`);
        }
    }
    
    const result = {
        groupName: groupName || 'Unknown Group',
        memberCount: memberCount || 0,
        success: groupName !== null && memberCount !== null
    };
    
    console.log('\n🎯 === FINAL ADVANCED RESULT ===');
    console.log(`   Group Name: "${result.groupName}"`);
    console.log(`   Member Count: ${result.memberCount}`);
    console.log(`   Success: ${result.success}`);
    console.log('=================================\n');
    
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

// Fungsi untuk membuat hash dari content
function createContentHash(content) {
    return Buffer.from(content).toString('base64').slice(0, 20);
}

// Fungsi update message yang super aman dengan anti-duplicate
async function superSafeUpdateMessage(chatId, messageId, groups, isProcessing = false) {
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
        
        // Create content hash untuk prevent duplicate
        const contentHash = createContentHash(text);
        const session = userSessions.get(chatId);
        
        // Cek apakah content sama dengan sebelumnya
        if (session && session.messageContentHash === contentHash) {
            console.log('⏭️ Skipping update - identical content hash');
            return messageId;
        }
        
        // Update hash
        if (session) {
            session.messageContentHash = contentHash;
            session.lastMessageContent = text;
        }
        
        const keyboard = createKeyboard(groups.length > 0);
        
        // Strategy 1: Try to edit existing message
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
                console.log('⚠️ Edit failed, trying fallback:', editError.message);
                
                // Strategy 2: Send new message if edit fails
                try {
                    const newMsg = await bot.sendMessage(chatId, text, {
                        parse_mode: 'Markdown',
                        reply_markup: keyboard
                    });
                    console.log('✅ New message sent as fallback');
                    
                    // Try to delete old message (optional)
                    try {
                        await bot.deleteMessage(chatId, messageId);
                        console.log('🗑️ Old message deleted');
                    } catch (deleteError) {
                        console.log('⚠️ Could not delete old message:', deleteError.message);
                    }
                    
                    return newMsg.message_id;
                } catch (sendError) {
                    console.error('❌ Fallback send failed:', sendError.message);
                    return null;
                }
            }
        } else {
            // Strategy 3: Send new message if no messageId
            try {
                const newMsg = await bot.sendMessage(chatId, text, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
                console.log('✅ New message sent');
                return newMsg.message_id;
            } catch (sendError) {
                console.error('❌ Message send failed:', sendError.message);
                return null;
            }
        }
        
    } catch (error) {
        console.error('❌ Message update error:', error.message);
        
        // Ultimate fallback: Send simple text message
        try {
            const simpleText = `🤖 BOT REKAP GRUP\n\nGrup terdeteksi: ${groups.length}\nTotal anggota: ${groups.reduce((sum, g) => sum + g.members, 0)}\n\nKirim foto grup WhatsApp`;
            
            const fallbackMsg = await bot.sendMessage(chatId, simpleText);
            console.log('✅ Ultimate fallback message sent');
            return fallbackMsg.message_id;
        } catch (ultimateError) {
            console.error('❌ Ultimate fallback failed:', ultimateError.message);
            return null;
        }
    }
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
            console.log('✅ Initial processing message created');
        } catch (error) {
            console.error('❌ Failed to create processing message:', error.message);
        }
    }
    
    // Update status processing
    session.processingMessageId = await superSafeUpdateMessage(chatId, session.processingMessageId, session.groups, true);
    
    // Proses setiap foto secara berurutan
    const currentQueue = [...session.photoQueue];
    session.photoQueue = [];
    
    for (let queueIndex = 0; queueIndex < currentQueue.length; queueIndex++) {
        const photoData = currentQueue[queueIndex];
        
        try {
            console.log(`📸 Processing photo ${photoData.order}/${currentQueue.length}: ${photoData.fileId}`);
            
            // Download foto
            const imagePath = await downloadPhoto(photoData.fileId);
            console.log(`✅ Downloaded: ${imagePath}`);
            
            // OCR dengan OCR.space
            const extractedText = await performOCRSpace(imagePath);
            
            // Parse dengan algoritma advanced
            const groupInfo = parseWhatsAppGroupAdvanced(extractedText);
            
            if (groupInfo.success && groupInfo.memberCount > 0) {
                session.addGroup(groupInfo.groupName, groupInfo.memberCount);
                
                console.log(`✅ Added group ${session.groups.length}: "${groupInfo.groupName}" - ${groupInfo.memberCount} members`);
                
                // Update hasil incremental setelah setiap foto
                session.processingMessageId = await superSafeUpdateMessage(chatId, session.processingMessageId, session.groups, true);
            } else {
                console.log(`⚠️ No valid data extracted from photo ${photoData.order}`);
            }

            // Cleanup file
            try {
                if (fs.existsSync(imagePath)) {
                    fs.unlinkSync(imagePath);
                }
            } catch (cleanupError) {
                console.log('⚠️ File cleanup warning:', cleanupError.message);
            }

            // Delete user photo untuk mengurangi spam
            try {
                await bot.deleteMessage(chatId, photoData.messageId);
                console.log(`🗑️ Deleted user photo ${photoData.order}`);
            } catch (deleteError) {
                console.log('⚠️ Could not delete user photo:', deleteError.message);
            }
            
        } catch (error) {
            console.error(`❌ Error processing photo ${photoData.order}:`, error.message);
        }
    }
    
    // Update final status
    session.processingMessageId = await superSafeUpdateMessage(chatId, session.processingMessageId, session.groups, false);
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

    console.log(`📥 Photo queued as #${photoOrder}. Total queue: ${session.photoQueue.length}`);

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
                    console.log('✅ Final results displayed');
                } else {
                    await bot.answerCallbackQuery(query.id, { text: 'Belum ada grup yang terdeteksi!' });
                }
                break;

            case 'reset':
                if (session) {
                    session.reset();
                    console.log('🔄 Session reset for user', userId);
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

    const welcomeText = `🤖 **OCR.SPACE PERFECT BOT**

🎯 **Super Accurate WhatsApp Group Detection**

✨ **Fitur Unggulan:**
• OCR.space API untuk akurasi maksimal
• Advanced parsing algorithm
• Deteksi format: "292" → Nama Grup ✅
• Deteksi format: "Grup • 80 anggota" → 80 Anggota ✅
• Multi-language support
• Zero edit message errors
• Incremental results berurutan

📊 **Format Output:**
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
2. Kirim foto (bisa banyak sekaligus)
3. Tunggu 10 detik untuk auto-process
4. Lihat hasil real-time yang terus bertambah
5. Klik "Selesai" untuk hasil final

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
        const statusText = `📊 **STATUS REKAP SAAT INI**

🔄 Status: ${session.isProcessing ? 'Memproses' : 'Siap'}
📈 Total grup: ${session.groups.length}
👥 Total anggota: ${session.getTotalMembers()}
📸 Foto antrian: ${session.photoQueue.length}

**HASIL TERKINI:**
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

// Enhanced error handlers
bot.on('polling_error', (error) => {
    console.error('❌ Polling error:', error.code || 'Unknown', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise);
    console.error('❌ Reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    console.error('❌ Stack:', error.stack);
});

process.on('SIGINT', () => {
    console.log('🛑 Bot shutting down gracefully...');
    
    // Cleanup all sessions
    for (const [userId, session] of userSessions) {
        if (session.timer) {
            clearTimeout(session.timer);
        }
    }
    
    // Cleanup temp directory
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

// Startup messages
console.log('🚀 OCR.SPACE PERFECT BOT STARTED!');
console.log('🎯 Using OCR.space API for maximum accuracy');
console.log('🛡️ Enhanced error handling & message management');
console.log('🔑 API Key:', OCR_SPACE_API_KEY ? `${OCR_SPACE_API_KEY.slice(0, 8)}...` : 'NOT SET');
console.log('👥 Authorized Admins:', ADMIN_IDS);
console.log('📱 Ready to process WhatsApp group screenshots!');
console.log('===============================================');
