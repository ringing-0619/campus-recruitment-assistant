// 根据问题邮件模板构造的脱敏样本，不包含收件人信息或测评访问链接。
const common = { receivedAt: new Date('2026-09-28T10:00:00Z') };

export const yonyouAssessment = {
  receivedAt: new Date('2026-10-01T09:00:00Z'),
  subject: '【重要】用友集团2027届校园招聘-在线测评通知！',
  from: '招聘系统 <notice@mail.hrtools.cn>',
  messageId: 'yonyou-assessment',
  text: 'Wintalent招聘系统信函\n亲爱的同学，您好：感谢您应聘用友集团2027届校园招聘【 售前解决方案管培生-江苏区 】职位，为了让面试官更全面地了解你，现邀请您完成人才测评。\n本次测评需使用电脑作答，作答时间30-60分钟；测评有效期72小时，请务必在有效期内完成测评。\n开始测评 用友集团校招项目组 2026-11-02\n作答环境：请选择一段相对空闲的时间进行测评。\n注意事项：当您点击模块下的开始答题后，系统将开始计时。',
};

export const asiainfoApplication = {
  receivedAt: new Date('2026-10-01T08:00:00Z'),
  subject: '感谢应聘亚信科技2027校招',
  from: 'campus@quickmail.51job.com',
  messageId: 'asiainfo-application',
  text: '\n \n \n校园频道\n投递通知\n感谢应聘亚信科技2027校招\n尊敬的同学：感谢您应聘本公司。您的简历已经被发送至我们的简历数据库,简历编号是 12345 。我们会尽快阅读您的简历并给予回复。所有的通知都会发送到您的“校园招聘申请记录”和电子邮箱，请留意。         猜你喜欢                   岗位：算法工程师。公司：推荐企业。立刻投递',
};

export const huabaoApplication = {
  ...common,
  subject: '感谢您投递本公司职位',
  from: '招聘通知 <notice@shmail.ibeisen.com>',
  messageId: 'huabao-application',
  text: '此邮件由系统发出，请勿直接回复或转发他人\n同学，您好！\n感谢您投递我公司的 研发管培生(J90002) 职位，我们已经收到您的简历，期待能够与您成为同事。\n深圳市华宝新能源股份有限公司\n声明：本邮件含有保密信息，仅限于收件人所用。',
};

export const kpmgAssessments = ['第一部分', '第二部分'].map((part) => ({
  ...common,
  subject: `毕马威26/27校招测评邀请 - ${part}`,
  from: '校园招聘 <notice@mail.mokahr.com>',
  messageId: `kpmg-${part}`,
  text: `请不要以任何形式分享该邮件内容。请注意，2026-2027年度校招测评分为两部分，本次测评仅为${part}，另一部分测评请参考另一封邮件。谢谢。感谢您的投递！请在72小时内完成该测评问卷。`,
}));

export const dewuApplication = {
  ...common,
  subject: '【得物】简历投递成功',
  from: '得物招聘 <notice@mail.hire.feishu.cn>',
  messageId: 'dewu-application',
  text: '感谢你投递得物2027届校园招聘。目前你所投递的【数据分析师】职位，已成功完成简历提交。后续面试安排另行通知。',
};
