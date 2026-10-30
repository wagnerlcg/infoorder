const express = require('express');
const app = express();

// Aumenta o limite de payload caso venham arquivos em base64 grandes
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;

app.post('/webhook/whatsapp', async (req, res) => {
    try {
        const data = req.body;

        // A Evolution API envia diferentes eventos. Focamos no de mensagens.
        if (data.event === 'messages.upsert') {
            const messageData = data.data;
            
            // Ignora mensagens enviadas pelo próprio número da lanchonete
            if (messageData.key && messageData.key.fromMe) {
                return res.status(200).send({ status: 'ignored_own_message' });
            }

            const senderPhone = messageData.key?.remoteJid;
            const messageType = messageData.messageType; 

            console.log(`Nova mensagem de: ${senderPhone} | Tipo: ${messageType}`);

            // Tratamento de Texto
            if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
                const textContent = messageData.message?.conversation || messageData.message?.extendedTextMessage?.text;
                console.log(`Texto recebido: "${textContent}"`);
                // TODO: Enviar para a IA extrair o pedido
            } 
            
            // Tratamento de Áudio
            else if (messageType === 'audioMessage') {
                console.log('Áudio recebido!');
                // TODO: Pegar o áudio e mandar para o Whisper
            }
        }

        return res.status(200).send({ status: 'success' });
    } catch (error) {
        console.error('Erro ao processar webhook:', error);
        return res.status(500).send({ error: 'Internal Server Error' });
    }
});

app.get('/health', (req, res) => {
    res.status(200).send({ status: 'online' });
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});