const { Telegraf, Markup } = require('telegraf');
const { makeWASocket, DisconnectReason, useMultiFileAuthState, getAggregateVotesInPollMessage } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Token Bot Telegram
const BOT_TOKEN = '7781035249:AAHdINZifB8f7TOAJ7hy3h7lQ8MXKd48dKo';
const bot = new Telegraf(BOT_TOKEN);

// Crypto global
global.crypto = crypto;

// Admin Bot (ganti dengan ID Telegram admin)
const ADMIN_IDS = [5988451717]; // Isi dengan user ID admin

// Menyimpan koneksi WhatsApp per user
const waConnections = new Map();
const userStates = new Map();
const connectionStates = new Map();

// Middleware untuk cek admin
const isAdmin = (ctx) => {
    const userId = ctx.from?.id;
    return ADMIN_IDS.includes(userId);
};

// Fungsi untuk membuat koneksi WhatsApp
async function createWhatsAppConnection(userId, ctx) {
    try {
        // Set status koneksi aktif
        connectionStates.set(userId, { cancelled: false, connecting: true });
        
        const authFolder = path.join(__dirname, 'auth', userId.toString());
        await fs.mkdir(authFolder, { recursive: true });
        
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            // Cek apakah koneksi sudah dibatalkan
            const connState = connectionStates.get(userId);
            if (connState?.cancelled) {
                sock.end();
                return;
            }
            
            if (qr) {
                // Cek lagi sebelum kirim QR
                if (connState?.cancelled) {
                    sock.end();
                    return;
                }
                
                // Generate QR code
                try {
                    const qrImage = await QRCode.toBuffer(qr);
                    const qrMessage = await ctx.replyWithPhoto(
                        { source: qrImage },
                        {
                            caption: '📱 *Scan QR Code ini dengan WhatsApp*\n\n⏱ QR Code akan expire dalam 60 detik\n\n_Gunakan WhatsApp > Settings > Linked Devices_',
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([
                                [Markup.button.callback('❌ Cancel', 'cancel_connect')]
                            ])
                        }
                    );
                    
                    // Simpan message ID untuk dihapus nanti
                    userStates.set(userId, { qrMessageId: qrMessage.message_id });
                    
                    // Auto delete QR after 60 seconds
                    setTimeout(async () => {
                        try {
                            const state = userStates.get(userId);
                            if (state?.qrMessageId === qrMessage.message_id) {
                                await ctx.deleteMessage(qrMessage.message_id);
                            }
                        } catch (e) {}
                    }, 60000);
                } catch (error) {
                    console.error('Error generating QR:', error);
                }
            }
            
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
                
                // Cek apakah koneksi dibatalkan
                if (connState?.cancelled) {
                    waConnections.delete(userId);
                    connectionStates.delete(userId);
                    return;
                }
                
                if (shouldReconnect) {
                    createWhatsAppConnection(userId, ctx);
                } else {
                    waConnections.delete(userId);
                    connectionStates.delete(userId);
                    await ctx.reply('❌ *Koneksi WhatsApp terputus*\n\nSilakan gunakan /connect untuk menghubungkan kembali', { parse_mode: 'Markdown' });
                }
            } else if (connection === 'open') {
                // Hapus flag connecting
                connectionStates.delete(userId);
                
                const state = userStates.get(userId);
                if (state?.qrMessageId) {
                    try {
                        await ctx.deleteMessage(state.qrMessageId);
                    } catch (e) {}
                }
                
                await ctx.reply('✅ *WhatsApp berhasil terhubung!*\n\n📋 *Cara menggunakan:*\n1. Kirim link grup WhatsApp\n2. Bot akan menampilkan menu pengaturan grup\n\n💡 Gunakan /help untuk bantuan lebih lanjut', { parse_mode: 'Markdown' });
                userStates.delete(userId);
            }
        });
        
        waConnections.set(userId, sock);
        return sock;
    } catch (error) {
        console.error('Error creating WhatsApp connection:', error);
        connectionStates.delete(userId);
        throw error;
    }
}

// Helper function untuk mendapatkan info grup lengkap
async function getGroupFullInfo(sock, groupId) {
    try {
        const metadata = await sock.groupMetadata(groupId);
        const groupInfo = await sock.groupInviteCode(groupId).catch(() => null);
        
        // Get ephemeral setting
        let ephemeralSetting = 0;
        if (metadata.ephemeralDuration) {
            ephemeralSetting = metadata.ephemeralDuration;
        }
        
        return {
            metadata,
            inviteCode: groupInfo,
            ephemeral: ephemeralSetting
        };
    } catch (error) {
        console.error('Error getting group info:', error);
        throw error;
    }
}

// Command /start
bot.command('start', async (ctx) => {
    if (!isAdmin(ctx)) {
        return ctx.reply('❌ *Akses Ditolak*\n\nAnda bukan admin bot ini!', { parse_mode: 'Markdown' });
    }
    
    const welcomeMessage = `
🤖 *WhatsApp Group Manager Bot*

Selamat datang! Bot ini memungkinkan Anda mengelola grup WhatsApp melalui Telegram.

📋 *Perintah yang tersedia:*
/connect - Hubungkan akun WhatsApp
/logout - Hapus sesi WhatsApp
/status - Cek status koneksi
/help - Bantuan lengkap

💡 Mulai dengan /connect untuk menghubungkan WhatsApp Anda!
    `;
    
    await ctx.reply(welcomeMessage, { parse_mode: 'Markdown' });
});

// Command /connect
bot.command('connect', async (ctx) => {
    if (!isAdmin(ctx)) {
        return ctx.reply('❌ *Akses Ditolak*\n\nAnda bukan admin bot ini!', { parse_mode: 'Markdown' });
    }
    
    const userId = ctx.from.id;
    
    if (waConnections.has(userId)) {
        return ctx.reply('⚠️ *WhatsApp sudah terhubung!*\n\nGunakan /logout untuk menghapus sesi saat ini', { parse_mode: 'Markdown' });
    }
    
    // Cek apakah sedang dalam proses koneksi
    const connState = connectionStates.get(userId);
    if (connState?.connecting) {
        return ctx.reply('⚠️ *Proses koneksi sedang berjalan!*\n\nSilakan tunggu atau klik tombol Cancel pada QR Code', { parse_mode: 'Markdown' });
    }
    
    await ctx.reply('🔄 *Memulai proses koneksi WhatsApp...*', { parse_mode: 'Markdown' });
    
    try {
        await createWhatsAppConnection(userId, ctx);
    } catch (error) {
        await ctx.reply('❌ *Gagal membuat koneksi WhatsApp*\n\nSilakan coba lagi', { parse_mode: 'Markdown' });
    }
});

// Command /logout
bot.command('logout', async (ctx) => {
    if (!isAdmin(ctx)) {
        return ctx.reply('❌ *Akses Ditolak*\n\nAnda bukan admin bot ini!', { parse_mode: 'Markdown' });
    }
    
    const userId = ctx.from.id;
    const sock = waConnections.get(userId);
    
    if (!sock) {
        return ctx.reply('⚠️ *Tidak ada sesi WhatsApp aktif*', { parse_mode: 'Markdown' });
    }
    
    // Konfirmasi logout
    await ctx.reply(
        '⚠️ *Konfirmasi Logout*\n\nApakah Anda yakin ingin logout dari WhatsApp?',
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [
                    Markup.button.callback('✅ Ya, Logout', 'confirm_logout'),
                    Markup.button.callback('❌ Batal', 'cancel_logout')
                ]
            ])
        }
    );
});

// Command /status
bot.command('status', async (ctx) => {
    if (!isAdmin(ctx)) {
        return ctx.reply('❌ *Akses Ditolak*\n\nAnda bukan admin bot ini!', { parse_mode: 'Markdown' });
    }
    
    const userId = ctx.from.id;
    const sock = waConnections.get(userId);
    
    if (!sock) {
        return ctx.reply('❌ *Status: Tidak Terhubung*\n\nGunakan /connect untuk menghubungkan WhatsApp', { parse_mode: 'Markdown' });
    }
    
    const user = sock.user;
    const statusMessage = `
✅ *Status: Terhubung*

📱 *Info Akun:*
👤 Nama: ${user?.name || 'Unknown'}
📞 Nomor: ${user?.id?.split('@')[0] || 'Unknown'}

🔗 Kirim link grup WhatsApp untuk mengelola
    `;
    
    await ctx.reply(statusMessage, { parse_mode: 'Markdown' });
});

// Command /help
bot.command('help', async (ctx) => {
    if (!isAdmin(ctx)) {
        return ctx.reply('❌ *Akses Ditolak*\n\nAnda bukan admin bot ini!', { parse_mode: 'Markdown' });
    }
    
    const helpMessage = `
📚 *Panduan Penggunaan Bot*

🔹 */connect* - Hubungkan akun WhatsApp
🔹 */logout* - Hapus sesi WhatsApp  
🔹 */status* - Cek status koneksi
🔹 */help* - Tampilkan bantuan ini

📱 *Cara Mengelola Grup:*
1. Pastikan WhatsApp terhubung (/connect)
2. Kirim link grup WhatsApp (https://chat.whatsapp.com/xxx)
3. Bot akan menampilkan menu pengaturan grup
4. Klik tombol untuk mengubah pengaturan

⚙️ *Fitur Grup yang Bisa Dikelola:*
• Edit Info Grup (ON/OFF)
• Kirim Pesan (ON/OFF)  
• Tambah Anggota (ALL/ADMIN)
• Pesan Sementara (ON/OFF)
• Setujui Anggota (ON/OFF)
• Upload Foto Grup

💡 *Tips:*
- Pastikan Anda adalah admin di grup WhatsApp
- Bot akan otomatis menghapus foto QR yang sudah tidak digunakan
- Semua perubahan langsung diterapkan ke grup WhatsApp
    `;
    
    await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
});

// Handle text messages (untuk link grup)
bot.on('text', async (ctx) => {
    if (!isAdmin(ctx)) return;
    
    const userId = ctx.from.id;
    const sock = waConnections.get(userId);
    const text = ctx.message.text;
    
    if (!sock) {
        return ctx.reply('⚠️ *WhatsApp belum terhubung!*\n\nGunakan /connect terlebih dahulu', { parse_mode: 'Markdown' });
    }
    
    // Check if it's a WhatsApp group link
    const groupLinkRegex = /https:\/\/chat\.whatsapp\.com\/([A-Za-z0-9]+)/;
    const match = text.match(groupLinkRegex);
    
    if (!match) {
        return;
    }
    
    const inviteCode = match[1];
    
    try {
        // Join group if not already joined
        const groupId = await sock.groupAcceptInvite(inviteCode);
        
        // Get group metadata dan info lengkap
        const groupFullInfo = await getGroupFullInfo(sock, groupId);
        const groupMetadata = groupFullInfo.metadata;
        
        // Get current settings
        const settings = {
            editInfo: groupMetadata.restrict ? '🔒 ADMIN' : '✅ ALL',
            sendMessage: groupMetadata.announce ? '🔒 ADMIN' : '✅ ALL',
            addMember: groupMetadata.memberAddMode ? '🔒 ADMIN' : '✅ ALL',
            ephemeral: groupFullInfo.ephemeral > 0 ? '✅ ON' : '❌ OFF',
            approveMembers: groupMetadata.joinApprovalMode ? '✅ ON' : '❌ OFF'
        };
        
        const message = `
🎯 *Sedang mengelola grup:*
_${groupMetadata.subject}_

👥 *Anggota:* ${groupMetadata.participants.length} orang
📅 *Dibuat:* ${new Date(groupMetadata.creation * 1000).toLocaleDateString('id-ID')}
${groupMetadata.desc ? `📝 *Deskripsi:* ${groupMetadata.desc}\n` : ''}

⚙️ *Pengaturan Grup Saat Ini:*
        `;
        
        const keyboard = [
            [Markup.button.callback(`📝 Edit Info: ${settings.editInfo}`, `toggle_edit_${groupId}`)],
            [Markup.button.callback(`💬 Kirim Pesan: ${settings.sendMessage}`, `toggle_send_${groupId}`)],
            [Markup.button.callback(`➕ Tambah Anggota: ${settings.addMember}`, `toggle_add_${groupId}`)],
            [Markup.button.callback(`⏰ Pesan Sementara: ${settings.ephemeral}`, `toggle_ephemeral_${groupId}`)],
            [Markup.button.callback(`✅ Setujui Anggota: ${settings.approveMembers}`, `toggle_approve_${groupId}`)],
            [Markup.button.callback('🖼 Upload Foto Grup', `upload_photo_${groupId}`)],
            [Markup.button.callback('🔄 Refresh', `refresh_${groupId}`)],
            [Markup.button.callback('❌ Tutup', 'close_menu')]
        ];
        
        await ctx.reply(message, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(keyboard)
        });
        
    } catch (error) {
        console.error('Error processing group link:', error);
        await ctx.reply('❌ *Gagal memproses link grup*\n\nPastikan link valid dan bot memiliki akses', { parse_mode: 'Markdown' });
    }
});

// Handle photo untuk upload foto grup
bot.on('photo', async (ctx) => {
    if (!isAdmin(ctx)) return;
    
    const userId = ctx.from.id;
    const state = userStates.get(userId);
    
    if (!state?.waitingForPhoto) return;
    
    const sock = waConnections.get(userId);
    if (!sock) return;
    
    try {
        await ctx.reply('🔄 *Mengupload foto grup...*', { parse_mode: 'Markdown' });
        
        // Download foto
        const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        const fileUrl = await ctx.telegram.getFileLink(fileId);
        
        // Download file
        const response = await fetch(fileUrl.href);
        const buffer = await response.buffer();
        
        // Update profile picture grup
        await sock.updateProfilePicture(state.groupId, buffer);
        
        await ctx.reply('✅ *Foto grup berhasil diupdate!*', { parse_mode: 'Markdown' });
        
        // Reset state
        userStates.set(userId, { ...state, waitingForPhoto: false, groupId: null });
        
    } catch (error) {
        console.error('Error uploading group photo:', error);
        await ctx.reply('❌ *Gagal mengupload foto grup*\n\nPastikan Anda admin di grup tersebut', { parse_mode: 'Markdown' });
    }
});

// Callback query handlers
bot.action('cancel_connect', async (ctx) => {
    const userId = ctx.from.id;
    
    // Set flag cancelled
    const connState = connectionStates.get(userId);
    if (connState) {
        connState.cancelled = true;
    }
    
    // Hapus koneksi jika ada
    const sock = waConnections.get(userId);
    if (sock) {
        sock.end();
        waConnections.delete(userId);
    }
    
    // Hapus state
    userStates.delete(userId);
    connectionStates.delete(userId);
    
    // Hapus pesan QR
    await ctx.deleteMessage();
    await ctx.reply('❌ *Proses koneksi dibatalkan*', { parse_mode: 'Markdown' });
});

bot.action('confirm_logout', async (ctx) => {
    const userId = ctx.from.id;
    const sock = waConnections.get(userId);
    
    if (sock) {
        sock.logout();
        waConnections.delete(userId);
        
        // Hapus folder auth
        try {
            const authFolder = path.join(__dirname, 'auth', userId.toString());
            await fs.rmdir(authFolder, { recursive: true });
        } catch (e) {}
    }
    
    // Hapus semua state
    userStates.delete(userId);
    connectionStates.delete(userId);
    
    await ctx.editMessageText('✅ *Berhasil logout dari WhatsApp*\n\nSesi telah dihapus', { parse_mode: 'Markdown' });
});

bot.action('cancel_logout', async (ctx) => {
    await ctx.editMessageText('❌ *Logout dibatalkan*', { parse_mode: 'Markdown' });
});

bot.action('close_menu', async (ctx) => {
    await ctx.deleteMessage();
    await ctx.answerCbQuery('Menu ditutup');
});

// Toggle handlers
bot.action(/toggle_edit_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    const userId = ctx.from.id;
    const sock = waConnections.get(userId);
    
    if (!sock) return ctx.answerCbQuery('WhatsApp tidak terhubung!');
    
    try {
        await ctx.answerCbQuery('🔄 Mengubah pengaturan...');
        
        // Toggle restrict setting
        const groupMetadata = await sock.groupMetadata(groupId);
        await sock.groupSettingUpdate(groupId, groupMetadata.restrict ? 'unlocked' : 'locked');
        
        // Update message
        await updateGroupMessage(ctx, sock, groupId);
    } catch (error) {
        await ctx.answerCbQuery('❌ Gagal mengubah pengaturan');
    }
});

bot.action(/toggle_send_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    const userId = ctx.from.id;
    const sock = waConnections.get(userId);
    
    if (!sock) return ctx.answerCbQuery('WhatsApp tidak terhubung!');
    
    try {
        await ctx.answerCbQuery('🔄 Mengubah pengaturan...');
        
        // Toggle announce setting
        const groupMetadata = await sock.groupMetadata(groupId);
        await sock.groupSettingUpdate(groupId, groupMetadata.announce ? 'not_announcement' : 'announcement');
        
        // Update message
        await updateGroupMessage(ctx, sock, groupId);
    } catch (error) {
        await ctx.answerCbQuery('❌ Gagal mengubah pengaturan');
    }
});

bot.action(/toggle_add_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    const userId = ctx.from.id;
    const sock = waConnections.get(userId);
    
    if (!sock) return ctx.answerCbQuery('WhatsApp tidak terhubung!');
    
    try {
        await ctx.answerCbQuery('🔄 Mengubah pengaturan...');
        
        // Toggle member add mode
        const groupMetadata = await sock.groupMetadata(groupId);
        await sock.groupMemberAddMode(groupId, groupMetadata.memberAddMode ? 'all_member_can_add' : 'admin_only');
        
        // Update message
        await updateGroupMessage(ctx, sock, groupId);
    } catch (error) {
        await ctx.answerCbQuery('❌ Gagal mengubah pengaturan');
    }
});

bot.action(/toggle_ephemeral_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    const userId = ctx.from.id;
    const sock = waConnections.get(userId);
    
    if (!sock) return ctx.answerCbQuery('WhatsApp tidak terhubung!');
    
    try {
        await ctx.answerCbQuery('🔄 Mengubah pengaturan...');
        
        // Toggle ephemeral messages (24 hours or off)
        const groupFullInfo = await getGroupFullInfo(sock, groupId);
        const newDuration = groupFullInfo.ephemeral > 0 ? 0 : 86400; // 0 = off, 86400 = 24 hours
        
        await sock.groupToggleEphemeral(groupId, newDuration);
        
        // Update message
        await updateGroupMessage(ctx, sock, groupId);
    } catch (error) {
        await ctx.answerCbQuery('❌ Gagal mengubah pengaturan');
    }
});

bot.action(/toggle_approve_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    const userId = ctx.from.id;
    const sock = waConnections.get(userId);
    
    if (!sock) return ctx.answerCbQuery('WhatsApp tidak terhubung!');
    
    try {
        await ctx.answerCbQuery('🔄 Mengubah pengaturan...');
        
        // Toggle join approval mode
        const groupMetadata = await sock.groupMetadata(groupId);
        await sock.groupJoinApprovalMode(groupId, groupMetadata.joinApprovalMode ? 'off' : 'on');
        
        // Update message
        await updateGroupMessage(ctx, sock, groupId);
    } catch (error) {
        await ctx.answerCbQuery('❌ Gagal mengubah pengaturan');
    }
});

bot.action(/upload_photo_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    const userId = ctx.from.id;
    const sock = waConnections.get(userId);
    
    if (!sock) return ctx.answerCbQuery('WhatsApp tidak terhubung!');
    
    await ctx.answerCbQuery();
    await ctx.reply('📸 *Kirim foto untuk grup*\n\nSilakan kirim foto yang ingin dijadikan foto profil grup', { parse_mode: 'Markdown' });
    
    // Set state waiting for photo
    userStates.set(userId, { waitingForPhoto: true, groupId });
});

bot.action(/refresh_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    const userId = ctx.from.id;
    const sock = waConnections.get(userId);
    
    if (!sock) return ctx.answerCbQuery('WhatsApp tidak terhubung!');
    
    try {
        await ctx.answerCbQuery('🔄 Memperbarui...');
        await updateGroupMessage(ctx, sock, groupId);
    } catch (error) {
        await ctx.answerCbQuery('❌ Gagal memperbarui');
    }
});

// Function to update group message
async function updateGroupMessage(ctx, sock, groupId) {
    try {
        const groupFullInfo = await getGroupFullInfo(sock, groupId);
        const groupMetadata = groupFullInfo.metadata;
        
        const settings = {
            editInfo: groupMetadata.restrict ? '🔒 ADMIN' : '✅ ALL',
            sendMessage: groupMetadata.announce ? '🔒 ADMIN' : '✅ ALL',
            addMember: groupMetadata.memberAddMode ? '🔒 ADMIN' : '✅ ALL',
            ephemeral: groupFullInfo.ephemeral > 0 ? '✅ ON' : '❌ OFF',
            approveMembers: groupMetadata.joinApprovalMode ? '✅ ON' : '❌ OFF'
        };
        
        const message = `
🎯 *Sedang mengelola grup:*
_${groupMetadata.subject}_

👥 *Anggota:* ${groupMetadata.participants.length} orang
📅 *Dibuat:* ${new Date(groupMetadata.creation * 1000).toLocaleDateString('id-ID')}
${groupMetadata.desc ? `📝 *Deskripsi:* ${groupMetadata.desc}\n` : ''}

⚙️ *Pengaturan Grup Saat Ini:*
✅ *Berhasil diperbarui!*
        `;
        
        const keyboard = [
            [Markup.button.callback(`📝 Edit Info: ${settings.editInfo}`, `toggle_edit_${groupId}`)],
            [Markup.button.callback(`💬 Kirim Pesan: ${settings.sendMessage}`, `toggle_send_${groupId}`)],
            [Markup.button.callback(`➕ Tambah Anggota: ${settings.addMember}`, `toggle_add_${groupId}`)],
            [Markup.button.callback(`⏰ Pesan Sementara: ${settings.ephemeral}`, `toggle_ephemeral_${groupId}`)],
            [Markup.button.callback(`✅ Setujui Anggota: ${settings.approveMembers}`, `toggle_approve_${groupId}`)],
            [Markup.button.callback('🖼 Upload Foto Grup', `upload_photo_${groupId}`)],
            [Markup.button.callback('🔄 Refresh', `refresh_${groupId}`)],
            [Markup.button.callback('❌ Tutup', 'close_menu')]
        ];
        
        await ctx.editMessageText(message, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(keyboard)
        });
    } catch (error) {
        console.error('Error updating message:', error);
    }
}

// Error handling
bot.catch((err, ctx) => {
    console.error(`Error for ${ctx.updateType}:`, err);
    ctx.reply('❌ Terjadi kesalahan, silakan coba lagi');
});

// Start bot
bot.launch({
    dropPendingUpdates: true
}).then(() => {
    console.log('🤖 Bot Telegram WhatsApp Manager Started!');
    console.log('⚠️  Jangan lupa tambahkan ID admin di ADMIN_IDS');
}).catch(console.error);

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
