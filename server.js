const express = require('express');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Initialize services
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Middleware
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'SMS Automation Webhook Service Running' });
});

// Webhook endpoint for incoming SMS
app.post('/webhook/sms', async (req, res) => {
  console.log('Received SMS:', req.body);
  
  const { From, Body, To } = req.body;
  
  try {
    // Store incoming message
    await storeMessage(From, Body, 'inbound', 'customer');
    
    // Get or create customer
    const customer = await getOrCreateCustomer(From);
    
    // Check if human has taken over
    if (customer.is_human_takeover) {
      console.log('Human takeover active, not sending AI response');
      res.status(200).send('Message stored for human review');
      return;
    }
    
    // Get AI response
    const aiResponse = await getAIResponse(From, Body, customer);
    
    // Send response via Twilio
    await twilioClient.messages.create({
      body: aiResponse,
      from: To, // Use the Twilio number that received the message
      to: From
    });
    
    // Store outbound message
    await storeMessage(From, aiResponse, 'outbound', 'ai');
    
    // Update qualification score
    await updateQualificationScore(customer.id, Body);
    
    console.log('Successfully processed message and sent AI response');
    res.status(200).send('Message processed');
  } catch (error) {
    console.error('Error processing message:', error);
    res.status(500).send('Error processing message');
  }
});

// API endpoint to send messages manually
app.post('/api/send-message', async (req, res) => {
  const { to, message } = req.body;
  
  try {
    const result = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to
    });
    
    // Store the message
    await storeMessage(to, message, 'outbound', 'human');
    
    res.json({ success: true, messageSid: result.sid });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

async function storeMessage(phoneNumber, body, direction, sender) {
  try {
    // Get customer ID
    const { data: customer } = await supabase
      .from('customers')
      .select('id')
      .eq('phone_number', phoneNumber)
      .single();
    
    const { error } = await supabase.from('messages').insert({
      customer_id: customer?.id,
      phone_number: phoneNumber,
      message_body: body,
      direction,
      sender
    });
    
    if (error) throw error;
    console.log('Message stored successfully');
  } catch (error) {
    console.error('Error storing message:', error);
  }
}

async function getOrCreateCustomer(phoneNumber) {
  try {
    let { data: customer, error } = await supabase
      .from('customers')
      .select('*')
      .eq('phone_number', phoneNumber)
      .single();
    
    if (error && error.code === 'PGRST116') {
      // Customer doesn't exist, create new one
      const { data: newCustomer, error: insertError } = await supabase
        .from('customers')
        .insert({ 
          phone_number: phoneNumber,
          status: 'lead'
        })
        .select()
        .single();
      
      if (insertError) throw insertError;
      customer = newCustomer;
      console.log('Created new customer:', phoneNumber);
    }
    
    return customer;
  } catch (error) {
    console.error('Error with customer:', error);
    throw error;
  }
}

async function getAIResponse(phoneNumber, message, customer) {
  try {
    // Get recent conversation history
    const { data: messages } = await supabase
      .from('messages')
      .select('*')
      .eq('phone_number', phoneNumber)
      .order('created_at', { ascending: true })
      .limit(10);
    
    // Build context for OpenAI
    const conversationHistory = messages
      .map(msg => `${msg.sender}: ${msg.message_body}`)
      .join('\n');
    
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `You are a helpful sales assistant for a business. Your goal is to:
          1. Be friendly and conversational
          2. Qualify leads by asking about their needs, budget, and timeline
          3. Try to schedule appointments for good prospects
          4. Keep responses under 160 characters when possible
          5. If someone seems like a good prospect, suggest they speak with a human
          
          Be natural and helpful, not pushy.`
        },
        {
          role: "user",
          content: `Conversation history:\n${conversationHistory}\n\nLatest message: ${message}\n\nRespond appropriately:`
        }
      ],
      max_tokens: 150,
      temperature: 0.7
    });
    
    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Error getting AI response:', error);
    return "Thanks for your message! Someone will get back to you soon.";
  }
}

async function updateQualificationScore(customerId, inboundMessage) {
  try {
    let scoreIncrease = 0;
    
    const message = inboundMessage.toLowerCase();
    
    // Simple scoring logic
    const positiveKeywords = ['interested', 'yes', 'want', 'need', 'buy', 'purchase', 'budget'];
    const urgentKeywords = ['urgent', 'asap', 'soon', 'now', 'today'];
    const qualifyingKeywords = ['timeline', 'when', 'how much', 'cost', 'price'];
    
    if (positiveKeywords.some(keyword => message.includes(keyword))) {
      scoreIncrease += 10;
    }
    
    if (urgentKeywords.some(keyword => message.includes(keyword))) {
      scoreIncrease += 15;
    }
    
    if (qualifyingKeywords.some(keyword => message.includes(keyword))) {
      scoreIncrease += 5;
    }
    
    if (scoreIncrease > 0) {
      await supabase.rpc('increment_qualification_score', {
        customer_id: customerId,
        score_increase: scoreIncrease
      });
      console.log(`Increased qualification score by ${scoreIncrease} for customer ${customerId}`);
    }
  } catch (error) {
    console.error('Error updating qualification score:', error);
  }
}

app.listen(port, () => {
  console.log(`SMS webhook service running on port ${port}`);
});
