import {AuthToaster} from "@/components/auth/auth-toast";
export default function AuthLayout({children}:{children:React.ReactNode}){return <main className="studio-account"><a href="/" className="studio-wordmark">W · 工作台</a><section><h1>开始创作</h1><p>在一个项目中完成需求、原型与交付。</p>{children}</section><AuthToaster/></main>;}
