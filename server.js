// Cargar variables de entorno desde el archivo .env
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { OpenAIClient, AzureKeyCredential } = require('@azure/openai');
const fs = require('fs');
const path = require('path');
const Papa = require('papaparse'); // Added for parsing CSV

// Configuración del servidor
const app = express();
const port = 3000;

// Middlewares
app.use(cors()); // Permite peticiones desde el frontend
app.use(express.json()); // Permite al servidor entender JSON
app.use(express.static(path.join(__dirname))); // Sirve los archivos estáticos (html, css, js)

// Configuración de archivos estáticos más específica
// app.use(express.static(path.join(__dirname), {
//     setHeaders: (res, filePath) => {
//         if (path.extname(filePath) === '.css') {
//             res.setHeader('Content-Type', 'text/css');
//             res.setHeader('Cache-Control', 'public, max-age=86400');
//         }
//         if (path.extname(filePath) === '.js') {
//             res.setHeader('Content-Type', 'application/javascript');
//             res.setHeader('Cache-Control', 'public, max-age=86400');
//         }
//     }
// }));

// Rutas específicas para archivos estáticos con manejo explícito
// app.get('/style.css', (req, res) => {
//     res.sendFile(path.join(__dirname, 'style.css'), {
//         headers: {
//             'Content-Type': 'text/css',
//             'Cache-Control': 'public, max-age=86400'
//         }
//     });
// });

// app.get('/app.js', (req, res) => {
//     res.sendFile(path.join(__dirname, 'app.js'), {
//         headers: {
//             'Content-Type': 'application/javascript',
//             'Cache-Control': 'public, max-age=86400'
//         }
//     });
// });

// Configuración del cliente de Azure OpenAI
const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureApiKey = process.env.AZURE_OPENAI_API_KEY;
const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME;

if (!endpoint || !azureApiKey || !deploymentName) {
    console.error("Error: Las variables de entorno AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY y AZURE_OPENAI_DEPLOYMENT_NAME deben estar definidas.");
    process.exit(1);
}

const client = new OpenAIClient(endpoint, new AzureKeyCredential(azureApiKey));

// --- API Endpoint para el Agente de IA ---
app.post('/api/chat', async (req, res) => {
    console.log("Received request on /api/chat");
    const { prompt, projects } = req.body;

    if (!prompt || !projects) {
        return res.status(400).json({ error: 'El prompt y la lista de proyectos son requeridos.' });
    }

    // --- PASO 1: La IA traduce el lenguaje natural a un JSON estructurado (PROMPT REFORZADO v4 para GPT-4) ---
    const systemMessageForJson = {
        role: "system",
        content: `Eres un asistente experto en análisis de portafolio de proyectos. 

### CONTEXTO:
- Total de Proyectos: 101
- Gerencias: Personas, Operaciones, Marketing, Comercial, Finanzas
- Beneficios: $25,000 - $1,200,000

### INSTRUCCIONES:
1. Convierte la petición del usuario en un JSON estructurado
2. Si no entiendes la petición, devuelve un JSON con selección por defecto

### ESTRUCTURA DEL JSON:
{
  "operation": "include", // Siempre "include"
  "criteria": [ // Filtros opcionales
    {
      "column": "Gerencia" | "Aporte_Estrategico" | "Beneficios_Estimados",
      "comparison": "contains" | "greater_than" | "less_than",
      "value": "texto o número"
    }
  ],
  "sortBy": { // Opcional
    "column": "Beneficios_Estimados",
    "order": "desc" | "asc"
  },
  "limit": 5 // Número de proyectos, por defecto 5
}

### EJEMPLOS:
1. "3 proyectos de operaciones con mayor ahorro"
   {"operation": "include", "criteria": [{"column": "Gerencia", "comparison": "contains", "value": "Operaciones"}], "sortBy": {"column": "Beneficios_Estimados", "order": "desc"}, "limit": 3}

2. "Proyectos sistémicos con beneficio mayor a 200 mil"
   {"operation": "include", "criteria": [{"column": "Aporte_Estrategico", "comparison": "contains", "value": "Sistémico"}, {"column": "Beneficios_Estimados", "comparison": "greater_than", "value": 200000}]}

3. "Los 5 proyectos con menor beneficio"
   {"operation": "include", "criteria": [], "sortBy": {"column": "Beneficios_Estimados", "order": "asc"}, "limit": 5}
`
    };

    let intentJson;
    try {
        const events = await client.streamChatCompletions(deploymentName, [systemMessageForJson, { role: "user", content: prompt }], { maxTokens: 512 });
        let responseContent = "";
        for await (const event of events) {
            for (const choice of event.choices) {
                const delta = choice.delta?.content;
                if (delta) { responseContent += delta; }
            }
        }

        console.log("Respuesta cruda de la IA:", responseContent); // Log completo

        // Limpieza robusta de la respuesta de la IA
        let cleanJsonString = responseContent.trim();
        const jsonMatch = cleanJsonString.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            cleanJsonString = jsonMatch[0];
        }

        try {
            intentJson = JSON.parse(cleanJsonString);

            // Validaciones adicionales
            if (!intentJson.operation) {
                intentJson = {
                    operation: "include",
                    criteria: [],
                    limit: 5 // Valor por defecto
                };
            }

            console.log("JSON procesado:", intentJson); // Log del JSON final
        } catch (parseError) {
            console.error("Error al parsear JSON:", parseError);
            intentJson = {
                operation: "include",
                criteria: [],
                limit: 5 // Valor por defecto
            };
        }

    } catch (error) {
        console.error("Error al obtener o parsear el JSON de la IA:", error);
        intentJson = {
            operation: "include",
            criteria: [],
            limit: 5 // Valor por defecto
        };
    }

    // --- PASO 2: El servidor ejecuta la lógica de datos basada en el JSON (LÓGICA REFACTORIZADA) ---
    try {
        const { operation, criteria, sortBy, limit } = intentJson;

        if ((!criteria || criteria.length === 0) && !sortBy && !limit) {
            console.warn("La IA no pudo determinar criterios, sortBy o limit. Devolviendo selección vacía.");
            return res.json({ response: '' });
        }

        const projectData = Papa.parse(projects, { header: true, skipEmptyLines: true }).data;
        let workingSet = [...projectData]; // Empezar con todos los proyectos

        const parseBenefit = (benefitString) => {
            if (!benefitString) return 0;
            return parseInt(benefitString.replace(/[^0-9]/g, ''), 10);
        };

        // 1. Aplicar Filtros
        if (criteria && criteria.length > 0) {
            workingSet = workingSet.filter(project => {
                return criteria.every(c => {
                    const projectValue = c.column === 'Beneficios_Estimados'
                        ? parseBenefit(project[c.column])
                        : project[c.column];
                    const comparisonValue = c.value;

                    switch (c.comparison) {
                        case 'less_than': return projectValue < comparisonValue;
                        case 'greater_than': return projectValue > comparisonValue;
                        case 'equal_to': return projectValue == comparisonValue;
                        case 'contains': return projectValue?.toLowerCase().includes(String(comparisonValue).toLowerCase());
                        default: return false;
                    }
                });
            });
        }

        // 2. Aplicar Ordenamiento
        if (sortBy && sortBy.column === 'Beneficios_Estimados') {
            workingSet.sort((a, b) => {
                const benefitA = parseBenefit(a[sortBy.column]);
                const benefitB = parseBenefit(b[sortBy.column]);
                return sortBy.order === 'desc' ? benefitB - benefitA : benefitA - benefitB;
            });
        }

        // 3. Aplicar Límite
        if (limit) {
            workingSet = workingSet.slice(0, limit);
        }

        // 4. Obtener los IDs del conjunto de proyectos resultante
        const targetIds = new Set(workingSet.map(p => p.ID));

        // 5. Aplicar la operación final (incluir o excluir)
        let finalIds;
        if (operation === 'include') {
            finalIds = Array.from(targetIds);
        } else { // 'exclude'
            const allIds = projectData.map(p => p.ID);
            finalIds = allIds.filter(id => !targetIds.has(id));
        }

        res.json({ response: finalIds.join(',') });

    } catch (error) {
        console.error("Error al procesar la lógica de filtrado:", error);
        res.status(500).json({ error: 'Error al ejecutar la selección de proyectos.' });
    }
});

// --- API Endpoint para el Agente de IA (Q&A) ---
app.post('/api/ask', async (req, res) => {
    console.log("Received request on /api/ask");
    const { prompt, projects } = req.body;

    if (!prompt || !projects) {
        return res.status(400).json({ error: 'El prompt y la lista de proyectos son requeridos.' });
    }

    // Parse and simplify the project data to be more token-efficient
    const projectData = Papa.parse(projects, { header: true, skipEmptyLines: true }).data;
    const simplifiedProjects = projectData.map(p => ({
        id: p.ID,
        iniciativa: p.Iniciativa,
        gerencia: p.Gerencia,
        aporte: p.Aporte_Estrategico,
        beneficio: p.Beneficios_Estimados,
        keywords: p.Keywords,
        description: p.Description
    }));
    const simplifiedProjectsString = JSON.stringify(simplifiedProjects, null, 2);

    const systemMessageForQA = {
        role: "system",
        content: `Eres un Consultor de Estrategia de Negocios para Chilexpress. Tu misión es analizar un portafolio de proyectos de IA y responder a preguntas estratégicas con recomendaciones claras y justificadas.

### REGLAS DE ANÁLISIS:
1.  **Enfoque en Valor:** Tu análisis debe centrarse en maximizar beneficios (ingresos/ahorros), competitividad y alineamiento estratégico.
2.  **Respuesta Estructurada:** Tu respuesta DEBE ser únicamente un objeto JSON con la siguiente estructura:
    {
      "executiveSummary": "...",
      "recommendations": [ { "id": "...", "justification": "..." } ],
      "synergies": "...",
      "risks": "..."
    }
3.  **Contenido de la Respuesta:**
    - **executiveSummary:** Un párrafo corto y directo con tu conclusión principal para un gerente.
    - **recommendations:** Una lista de los 2-4 proyectos MÁS IMPORTANTES. Para cada uno, provee una 'justification' concisa de su impacto en el negocio.
    - **synergies:** Un análisis breve (1-2 frases) de cómo los proyectos recomendados se potencian entre sí.
    - **risks:** Una advertencia breve (1-2 frases) sobre posibles desafíos o riesgos al implementar esta cartera (ej. "dependencia de datos", "complejidad operativa").

### EJEMPLO DE PREGUNTA:
"¿Cómo podemos optimizar marketing?"

### EJEMPLO DE JSON DE SALIDA:
{
  "executiveSummary": "Para optimizar marketing, recomiendo un enfoque dual: mejorar la retención de clientes actuales y personalizar la adquisición de nuevos. La combinación de predicción de churn y personalización de contenido generará el mayor impacto en ingresos y lealtad.",
  "recommendations": [
    { "id": "41", "justification": "Permite actuar proactivamente para retener clientes valiosos antes de que abandonen, protegiendo una fuente clave de ingresos." },
    { "id": "57", "justification": "Aumenta la efectividad de las campañas al adaptar el contenido a cada segmento de cliente, mejorando la conversión y el ROI." }
  ],
  "synergies": "El modelo de churn (41) identifica clientes en riesgo, mientras que la hiperpersonalización (57) entrega el mensaje correcto para retenerlos, creando un ciclo virtuoso.",
  "risks": "El éxito de esta estrategia depende de la calidad y disponibilidad de los datos de comportamiento del cliente."
}`
    };

    try {
        const messages = [
            systemMessageForQA,
            { role: "user", content: `Aquí están los datos de los proyectos en formato JSON:\n\n${simplifiedProjectsString}\n\nAhora, por favor responde a la siguiente pregunta: ${prompt}` }
        ];

        const events = await client.streamChatCompletions(deploymentName, messages, { maxTokens: 2048 });

        let responseContent = "";
        for await (const event of events) {
            for (const choice of event.choices) {
                const delta = choice.delta?.content;
                if (delta) { responseContent += delta; }
            }
        }

        // Limpieza robusta de la respuesta de la IA para asegurar que es un JSON válido
        let cleanJsonString = responseContent.trim();
        const jsonMatch = cleanJsonString.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            cleanJsonString = jsonMatch[0];
        }

        res.json(JSON.parse(cleanJsonString));

    } catch (error) {
        console.error("Error en el endpoint /api/ask:", error);
        // Definir responseContent aquí para evitar el ReferenceError
        const responseContent = "No se pudo obtener respuesta de la IA.";
        res.status(500).json({ error: 'Error al procesar la pregunta.' });
    }
});

app.post('/api/generate-description', async (req, res) => {
    console.log("Received request on /api/generate-description");
    const { iniciativa, gerencia, keywords } = req.body;

    if (!iniciativa || !gerencia) {
        return res.status(400).json({ error: 'Iniciativa y gerencia son requeridos.' });
    }

    const systemMessage = {
        role: 'system',
        content: `Eres un consultor de estrategia de negocios para Chilexpress, una empresa líder en logística. Tu tarea es escribir una descripción concisa y persuasiva (2-3 frases) para una iniciativa de IA, enfocada en el valor de negocio y el impacto operativo para un público gerencial. No uses markdown.

Ejemplo de Input: { "iniciativa": "Ruteo Optimo", "gerencia": "Operaciones", "keywords": "ruteo, logistica" }
Ejemplo de Output: Optimiza las rutas de entrega en tiempo real para reducir costos de combustible y tiempos de viaje, impactando directamente en la eficiencia de la flota y la promesa de entrega al cliente.

Genera una descripción para la siguiente iniciativa:`
    };

    const userMessage = {
        role: 'user',
        content: JSON.stringify({ iniciativa, gerencia, keywords })
    };

    try {
        const events = await client.streamChatCompletions(deploymentName, [systemMessage, userMessage], { maxTokens: 256 });
        let responseContent = "";
        for await (const event of events) {
            for (const choice of event.choices) {
                const delta = choice.delta?.content;
                if (delta) { responseContent += delta; }
            }
        }
        res.json({ description: responseContent });
    } catch (error) {
        console.error("Error al generar descripción:", error);
        res.status(500).json({ error: 'No se pudo generar la descripción.' });
    }
});

// --- Ruta principal para servir el dashboard ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Iniciar el servidor
app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
});
