/* auth 模块统一出口：路由处理 + 可复用 Session 中间层 */
export { handleAuthRequest, requireSession } from './routes.js';
