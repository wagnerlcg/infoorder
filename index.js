const express = require('express');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const ai = new GoogleGenAI();

app.post('/webhook/whatsapp', async (req, res) => {
    try {
        const data = req.body;

        if (data.event === 'messages.upsert') {
            const messageData = data.data;
            
            if (messageData.key && messageData.key.fromMe) {
                return res.status(200).send({ status: 'ignored_own_message' });
            }

            const senderPhone = messageData.key?.remoteJid;
            const messageType = messageData.messageType; 
            let textoParaProcessar = "";

            // 1. CASO: Mensagem de Texto
            if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
                textoParaProcessar = messageData.message?.conversation || messageData.message?.extendedTextMessage?.text;
            } 
            
            // 2. CASO: Mensagem de Áudio
            else if (messageType === 'audioMessage') {
                console.log(`Áudio recebido de: ${senderPhone}`);
                
                // A Evolution API geralmente fornece a URL do arquivo de áudio ou o base64
                // Dependendo de como sua Evolution está configurada, podemos baixar o arquivo .ogg
                const audioUrl = messageData.message?.audioMessage?.url || messageData.audioUrl;
                
                if (audioUrl) {
                    // Transcreve o áudio usando o Whisper da OpenAI
                    textoParaProcessar = await transcreverAudioWhisper(audioUrl);
                } else {
                    console.log("URL do áudio não encontrada no payload.");
                }
            }

            // Se conseguimos extrair um texto (seja digitado ou vindo do áudio), mandamos para a IA
            if (textoParaProcessar) {
                console.log(`Texto final para análise: "${textoParaProcessar}"`);
                const pedidoEstruturado = await processarPedidoComIA(textoParaProcessar);
                console.log("Pedido estruturado pela IA:", JSON.stringify(pedidoEstruturado, null, 2));

                // TODO: Salvar no banco de dados e disparar via WebSocket para a tela da cozinha
            }
        }

        return res.status(200).send({ status: 'success' });
    } catch (error) {
        console.error('Erro ao processar webhook:', error);
        return res.status(500).send({ error: 'Internal Server Error' });
    }
});

// Função para transcrever áudio com a API do Whisper (OpenAI)
async function transcreverAudioWhisper(audioUrl) {
    try {
        // Baixa o arquivo de áudio da Evolution API como binário
        const responseAudio = await axios.get(audioUrl, { responseType: 'arraybuffer' });
        const audioBuffer = Buffer.from(responseAudio.data);

        // Prepara o FormData para enviar para a API da OpenAI
        const form = new FormData();
        form.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
        form.append('model', 'whisper-1');
        form.append('language', 'pt'); // Força o reconhecimento em português para melhorar a precisão

        const responseWhisper = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
            headers: {
                ...form.getHeaders(),
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` // Certifique-se de adicionar essa variável no Easypanel se for usar áudio
            }
        });

        return responseWhisper.data.text;
    } catch (error) {
        console.error('Erro ao transcrever áudio com Whisper:', error.response?.data || error.message);
        return "";
    }
}

// Função que usa o Gemini para extrair os dados do pedido em JSON
async function processarPedidoComIA(textoCliente) {
    try {
        const prompt = `
            Você é um assistente de IA especialista em extrair pedidos de delivery (lanchonete/pizzaria) a partir de mensagens de WhatsApp enviadas por clientes.
            Analise a mensagem abaixo e extraia as informações estritamente no formato JSON, seguindo este schema:
            {
              "cliente_nome": "Nome do cliente se mencionado, senão null",
              "itens": [
                {
                  "quantidade": 1,
                  "produto": "Nome do produto",
                  "observacao": "Detalhes como sem cebola, ponto da carne, etc. ou string vazia"
                }
              ],
              "tipo_pedido": "delivery ou retirada",
              "endereco_entrega": "Endereço completo se mencionado, senão null",
              "forma_pagamento": "Dinheiro, Pix, Cartão ou null",
              "troco_para": "Valor se precisar de troco, senão null"
            }

            Mensagem do cliente: "${textoCliente}"
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
            }
        });

        return JSON.parse(response.text);
    } catch (error) {
        console.error('Erro ao processar com o Gemini:', error);
        return { erro: 'Não foi possível estruturar o pedido' };
    }
}

app.get('/health', (req, res) => {
    res.status(200).send({ status: 'online' });
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});

// Lista de clientes conectados (painel da cozinha)
let clientesCozinha = [];

// Rota onde o painel da cozinha se conecta para receber pedidos em tempo real
app.get('/api/stream-pedidos', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Adiciona este cliente à lista
    clientesCozinha.push(res);

    req.on('close', () => {
        clientesCozinha = clientesCozinha.filter(client => client !== res);
    });
});

// Função auxiliar para enviar o pedido para todas as telas conectadas
function enviarParaCozinha(pedido) {
    clientesCozinha.forEach(client => {
        client.write(`data: ${JSON.stringify(pedido)}\n\n`);
    });
}
