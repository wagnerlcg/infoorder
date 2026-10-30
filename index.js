const express = require('express');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;

// Inicializa o SDK do Gemini (ele lê automaticamente a variável de ambiente GEMINI_API_KEY)
const ai = new GoogleGenAI();

app.post('/webhook/whatsapp', async (req, res) => {
    try {
        const data = req.body;

        if (data.event === 'messages.upsert') {
            const messageData = data.data;
            
            // Ignora mensagens enviadas pelo próprio número da lanchonete
            if (messageData.key && messageData.key.fromMe) {
                return res.status(200).send({ status: 'ignored_own_message' });
            }

            const senderPhone = messageData.key?.remoteJid;
            const messageType = messageData.messageType; 

            // CASO: Mensagem de Texto
            if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
                const textContent = messageData.message?.conversation || messageData.message?.extendedTextMessage?.text;
                console.log(`Mensagem de ${senderPhone}: "${textContent}"`);

                // Envia o texto para a IA estruturar
                const pedidoEstruturado = await processarPedidoComIA(textContent);
                console.log("Pedido estruturado pela IA:", JSON.stringify(pedidoEstruturado, null, 2));

                // TODO: Salvar no banco de dados e disparar via WebSocket para a tela da cozinha
            } 
            
            // CASO: Mensagem de Áudio (preparado para o próximo passo com o Whisper)
            else if (messageType === 'audioMessage') {
                console.log('Áudio recebido de:', senderPhone);
                // Aqui depois baixamos o áudio, mandamos pro Whisper e o texto transcrito vai para a mesma função da IA!
            }
        }

        return res.status(200).send({ status: 'success' });
    } catch (error) {
        console.error('Erro ao processar webhook:', error);
        return res.status(500).send({ error: 'Internal Server Error' });
    }
});

// Função que usa o Gemini para extrair os dados do pedido
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
                responseMimeType: 'application/json', // Garante que a IA vai cuspir um JSON válido
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