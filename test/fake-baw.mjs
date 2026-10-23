#!/usr/bin/env node
// Giả lập CLI baw cho test offline.
const a = process.argv.slice(2).join(' ');
const out = (o) => console.log(JSON.stringify(o));
if (a.startsWith('wallet status')) out({ success: true, data: { status: process.env.FAKE_DISCONNECTED ? 'UNCONNECTED' : 'CONNECTED' } });
else if (a.startsWith('wallet address')) out({ success: true, data: { addresses: [{ binanceChainId: '56', address: '0x1111111111111111111111111111111111111111' }] } });
else if (a.startsWith('wallet settings')) out({ success: true, data: { devMode: { enabled: true } } });
else if (a.startsWith('contract-call preview')) {
  const evil = process.env.FAKE_AUTHORITY === '1';
  out({ success: true, data: { requestId: /--to 0x55d398326f99059fF775485246999027B3197955/i.test(a) ? 'req-approve' : 'req-1', parsedTx: { transactionType: 'ContractCall' }, simulationResult: { balanceChanges: [], allowanceChanges: evil ? [{ spender: '0xbad' }] : [], authorityChanges: [] }, risks: { riskDetails: [], addresses: {} }, requireConfirmation: false } });
} else if (a.startsWith('contract-call execute')) out({ success: true, data: { orderId: 'o1', status: 'BROADCASTED', txHash: '0x' + (a.includes('req-approve') ? 'ab' : 'ef').repeat(32) } });
else if (a.startsWith('wallet balance')) out({ success: true, data: [{ symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', binanceChainId: '56', balance: '25.5', price: '1.0', value: '25.5' }, { symbol: 'BNB', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', binanceChainId: '56', balance: '0.031', price: '600', value: '18.6' }] });
else if (a.startsWith('auth signin')) out({ success: true, data: { urlForWeb: 'https://web3.binance.com/en/agent-login?x=1', qrCodeId: 'qr-1', expireAt: '1772767626000', pairingCode: '654321' } });
else if (a.startsWith('auth verify')) { setTimeout(() => out({ success: true, data: { status: 'SUCCESS' } }), process.env.FAKE_DISCONNECTED ? 60000 : 300); }
else if (a.startsWith('auth signout')) out({ success: true, data: { status: 'LOGGED_OUT' } });
else if (a.startsWith('approvals list') && a.includes('--binanceChainId')) { console.error("error: unknown option '--binanceChainId'"); process.exitCode = 1; }
else if (a.startsWith('approvals list')) out({ success: true, data: { list: [{ tokenSymbol: 'USDT', tokenContract: '0x55d398326f99059fF775485246999027B3197955', tokenDecimals: 18, spender: '0x5555555555555555555555555555555555555555', spenderName: null, amount: 'unlimited', riskyLevel: 'high', riskyMsg: 'Spender contract is unverified', binanceChainId: '56', type: 'approve' }, { tokenSymbol: 'ETH', tokenContract: '0x2222222222222222222222222222222222222222', spender: '0x3333333333333333333333333333333333333333', amount: '1', binanceChainId: '1', type: 'approve' }], offset: 0, limit: 20, total: 1 } });
else if (a.startsWith('approvals revoke')) out({ success: true, data: { orderId: 'r1', status: 'BROADCASTED', txHash: '0x' + 'cd'.repeat(32) } });
else out({ success: false, error: { message: 'unknown ' + a } });
